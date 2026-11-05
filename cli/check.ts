import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { check } from "../src/checker.js";
import type { Report, SourceFacts } from "../src/contract.js";
import { isObj } from "../src/expr.js";
import type { QueryStamp } from "../src/query.js";
import { markdownFacts, parseMarkdownConfig, validateMarkdownConfig, type MarkdownConfig, type MarkdownDoc } from "../src/markdown.js";

/** The project configuration file, at the git top level of the project. */
export const CONFIG_FILE = "avouch.config.json";

// The next step when a repository has no Avouch project yet (no configuration and no default ontology).
// The next step when a command needs an adapter and none is set: the guide section for agents.
export const ADAPTER_HINT = "next step: https://github.com/githonllc/avouch/blob/main/docs/adapter-guide.md#for-ai-agents (Markdown documents need only {\"adapter\": {\"markdown\": {\"docs\": [...]}}} in avouch.config.json; other documents need an adapter module)";
export const SETUP_HINT = `to set up a project, run \`npx -y @githonllc/avouch init\`, then /avouch:scan in Claude Code (it drafts ${CONFIG_FILE} and a first ontology)`;

/**
 * An adapter, ready to run. `label` is the value of `check.adapter` in a query or gate stamp. A Markdown configuration reads
 * its documents relative to `dir`; `where` is the prefix of an error about it.
 */
export type Adapter =
  | { kind: "markdown"; config: MarkdownConfig; dir: string; where: string; label: string }
  | { kind: "module"; path: string; label: string };

/** The adapter named by `--adapter`: a `.json` file is the configuration of the built-in Markdown adapter, anything else a module. */
export function adapterFromArgument(arg: string): Adapter {
  if (!arg.endsWith(".json")) return { kind: "module", path: resolve(arg), label: arg };
  const path = resolve(arg);
  return { kind: "markdown", config: parseMarkdownConfig(readFileSync(path, "utf8"), arg), dir: dirname(path), where: arg, label: arg };
}

// `adapter` is an adapter ready to run (the inline Markdown configuration), or a string adapter: the path as written in the file
// and as resolved against it. The file that the string names is checked and read only when the adapter is used.
// `ledger`: the optional `ledger` key of `avouch gate docs`, validated, with its paths as written.
interface ProjectConfig { file: string; ontology: string | null; adapter: Adapter | { written: string; path: string }; ledger: { file?: string; docs?: string[] } | null }

// Reads and validates an avouch.config.json (strict: an unknown key is an error). Throws `<file>: <json path>: <problem>`.
// `label` names the file in the stamp: the --config argument as given, or CONFIG_FILE when the file was found at the git top.
function loadProjectConfig(file: string, label: string): ProjectConfig {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${file}: ${path}: ${problem}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    return fail("(root)", `not valid JSON: ${(error as Error).message}`);
  }
  if (!isObj(raw)) return fail("(root)", "must be an object");
  for (const k of Object.keys(raw)) if (k !== "ontology" && k !== "adapter" && k !== "ledger") fail(k, "unknown key");
  // `ontology` is optional here; a command that needs it fails in resolveProject or resolveLedger
  if (Object.hasOwn(raw, "ontology") && (typeof raw.ontology !== "string" || raw.ontology === "")) fail("ontology", "must be a non-empty string");
  if (!Object.hasOwn(raw, "adapter")) fail("adapter", "missing");
  const a = raw.adapter;
  const dir = dirname(resolve(file));
  const ontology = typeof raw.ontology === "string" ? resolve(dir, raw.ontology) : null;
  let ledger: ProjectConfig["ledger"] = null;
  if (Object.hasOwn(raw, "ledger")) {
    const l = raw.ledger;
    if (!isObj(l)) fail("ledger", "must be an object");
    for (const k of Object.keys(l)) if (k !== "file" && k !== "docs") fail(`ledger.${k}`, "unknown key");
    ledger = {};
    if (Object.hasOwn(l, "file")) {
      if (typeof l.file !== "string" || l.file === "") fail("ledger.file", "must be a non-empty string");
      ledger.file = l.file;
    }
    if (Object.hasOwn(l, "docs")) {
      if (!Array.isArray(l.docs) || l.docs.length === 0) fail("ledger.docs", "must be a non-empty array of strings");
      const docs = l.docs as unknown[];
      docs.forEach((d, i) => {
        if (typeof d !== "string" || d === "") fail(`ledger.docs[${i}]`, "must be a non-empty string");
        const j = docs.indexOf(d);
        if (j !== i) fail(`ledger.docs[${i}]`, `duplicate of ledger.docs[${j}]`);
      });
      ledger.docs = [...docs] as string[];
    }
  }
  if (typeof a === "string") {
    if (a === "") fail("adapter", "must be a non-empty string");
    return { file, ontology, adapter: { written: a, path: resolve(dir, a) }, ledger };
  }
  if (!isObj(a)) return fail("adapter", "must be a string or an object");
  for (const k of Object.keys(a)) if (k !== "markdown") fail(`adapter.${k}`, "unknown key");
  if (!Object.hasOwn(a, "markdown")) fail("adapter.markdown", "missing");
  if (!isObj(a.markdown)) fail("adapter.markdown", "must be an object");
  const where = `${file}: adapter.markdown`;
  return { file, ontology, adapter: { kind: "markdown", config: validateMarkdownConfig(a.markdown, where), dir, where, label: `${label}#adapter` }, ledger };
}

// The git top level of a directory, or null when it is not in a git repository (or git is not available).
export function gitTop(cwd: string): string | null {
  const r = spawnSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.error !== undefined || r.status !== 0 ? null : r.stdout.trim();
}

const isFile = (path: string): boolean => {
  try {
    return statSync(resolve(path)).isFile();
  } catch {
    return false;
  }
};

const real = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

// The project configuration: `configArg` (--config), else avouch.config.json at the git top level of `startDir` (a directory
// that is not in a git repository has none). `top` is the git top level when it was looked up.
function findProjectConfig(configArg: string | undefined, startDir: string): { config: ProjectConfig | null; top: string | null } {
  if (configArg !== undefined) return { config: loadProjectConfig(configArg, configArg), top: null };
  const top = gitTop(startDir);
  const file = top !== null && existsSync(join(top, CONFIG_FILE)) ? join(top, CONFIG_FILE) : null;
  return { config: file !== null ? loadProjectConfig(file, CONFIG_FILE) : null, top };
}

export interface ProjectOptions {
  /** -f */
  file?: string;
  /** --config */
  config?: string;
  /** --adapter */
  adapter?: string;
  /** true when the command must run the check */
  check: boolean;
}

/**
 * The ontology file of a command and, when it runs the check, the adapter.
 * Ontology: -f, else `ontology` of the project configuration, else avouch/avouch.ontology.yaml at the git top level.
 * Adapter: --adapter, else `adapter` of the project configuration.
 * The project configuration is --config, else avouch.config.json at the git top level of the directory of -f (with -f)
 * or of the working directory. It is read only when the command has no -f, or must run the check without --adapter.
 * A named -f or --config that is not a file is an error, whether or not the configuration is read (a stat, nothing more).
 */
export function resolveProject(o: ProjectOptions): { file: string; adapter: Adapter | null } {
  if (o.file !== undefined && !isFile(o.file)) throw new Error(`-f ${o.file}: file not found`);
  if (o.config !== undefined && !isFile(o.config)) throw new Error(`--config ${o.config}: file not found`);
  const needAdapterFromConfig = o.check && o.adapter === undefined;
  const readConfig = o.file === undefined || needAdapterFromConfig;
  let top: string | null = null;
  let config: ProjectConfig | null = null;
  if (readConfig) ({ config, top } = findProjectConfig(o.config, o.file !== undefined ? dirname(resolve(o.file)) : process.cwd()));
  let file: string;
  if (o.file !== undefined) file = o.file;
  else if (config !== null) {
    if (config.ontology === null) throw new Error(`${config.file}: ontology: missing`);
    if (!isFile(config.ontology)) throw new Error(`${config.file}: ontology: file not found`);
    file = config.ontology;
  } else {
    // no -f, no --config (a --config always gives a configuration): the git top level is the only place left to look
    if (top === null) throw new Error("no -f and no --config, and the working directory is not in a git repository (or git is not available)");
    const dflt = join(top, "avouch", "avouch.ontology.yaml");
    if (!existsSync(dflt)) throw new Error(`no -f, no ${CONFIG_FILE} at ${top}, and ${dflt} does not exist; ${SETUP_HINT}`);
    file = dflt;
  }
  if (!o.check) return { file, adapter: null };
  if (o.adapter !== undefined) return { file, adapter: adapterFromArgument(o.adapter) };
  if (config === null) {
    const dir = dirname(resolve(file));
    const where = top !== null ? join(top, CONFIG_FILE) : CONFIG_FILE;
    const rel = top !== null ? relative(top, join(dir, "avouch.json")) : join(dir, "avouch.json");
    const old = existsSync(join(dir, "avouch.json")) ? `; ${join(dir, "avouch.json")} is no longer read: set "adapter": "${rel}" in ${CONFIG_FILE}, or pass --adapter ${join(dir, "avouch.json")}` : "";
    throw new Error(`no adapter: pass --adapter, or set adapter in ${where}${old}; ${ADAPTER_HINT}`);
  }
  // a configuration without `ontology` has nothing to differ from -f
  if (o.file !== undefined && config.ontology !== null && real(o.file) !== real(config.ontology))
    throw new Error(`-f ${o.file} is not the ontology in ${config.file} (${config.ontology}): pass --adapter`);
  if (!("written" in config.adapter)) return { file, adapter: config.adapter };
  // the stamp holds the string as written, as --adapter stamps its argument as given
  if (!isFile(config.adapter.path)) throw new Error(`${config.file}: adapter: file not found`);
  return { file, adapter: { ...adapterFromArgument(config.adapter.path), label: config.adapter.written } };
}

/** The inputs of `avouch gate docs`: the ledger file, the ontology file and the documents (paths relative to the configuration directory, with `/`). */
export interface LedgerProject { config: string; dir: string; ledger: string; ontology: string; docs: string[] }

/**
 * The project of `avouch gate docs`: --config, else avouch.config.json at the git top level of the working directory.
 * The ledger file is `ledger.file` (default avouch.ledger.jsonl), relative to the configuration file. The documents are
 * `ledger.docs`, else the docs of the Markdown adapter; a module adapter has no docs, so it needs `ledger.docs`.
 */
export function resolveLedger(configOption: string | undefined): LedgerProject {
  let configFile: string;
  let label = CONFIG_FILE;
  if (configOption !== undefined) {
    if (!isFile(configOption)) throw new Error(`--config ${configOption}: file not found`);
    configFile = label = configOption;
  } else {
    const top = gitTop(process.cwd());
    if (top === null) throw new Error("no --config, and the working directory is not in a git repository (or git is not available)");
    configFile = join(top, CONFIG_FILE);
    if (!existsSync(configFile)) throw new Error(`no --config, and no ${CONFIG_FILE} at ${top}; ${SETUP_HINT}`);
  }
  const c = loadProjectConfig(configFile, label);
  if (c.ontology === null) throw new Error(`${configFile}: ontology: missing`);
  const ontology = c.ontology;
  const dir = dirname(resolve(configFile));
  let base = dir;
  let docs: string[];
  if (c.ledger?.docs !== undefined) docs = c.ledger.docs;
  else if (!("written" in c.adapter)) docs = c.adapter.kind === "markdown" ? c.adapter.config.docs : [];
  else if (!c.adapter.written.endsWith(".json")) throw new Error(`${configFile}: ledger.docs: missing (required with a module adapter)`);
  else {
    if (!isFile(c.adapter.path)) throw new Error(`${configFile}: adapter: file not found`);
    docs = parseMarkdownConfig(readFileSync(c.adapter.path, "utf8"), c.adapter.written).docs;
    base = dirname(c.adapter.path);
  }
  const rel = docs.map((d) => relative(dir, resolve(base, d)).split(sep).join("/"));
  // file identity (device and inode), as in readDocs: a case variant on a case-insensitive file system or a link is the same document
  const ids = rel.map((d) => {
    try {
      const st = statSync(resolve(dir, d));
      return `${st.dev}:${st.ino}`;
    } catch (error) {
      throw new Error(`${configFile}: ledger: ${d}: ${(error as Error).message}`);
    }
  });
  ids.forEach((id, j) => {
    if (ids.indexOf(id) !== j) throw new Error(`${configFile}: ledger: document ${rel[j]} is named twice`);
  });
  if (!isFile(ontology)) throw new Error(`${configFile}: ontology: file not found`);
  return { config: configFile, dir, ledger: resolve(dir, c.ledger?.file ?? "avouch.ledger.jsonl"), ontology, docs: rel };
}

// Reads the documents of a Markdown configuration (paths relative to the configuration file).
export function readDocs(a: Extract<Adapter, { kind: "markdown" }>): MarkdownDoc[] {
  const cfg = a.config;
  const docError = (i: number, error: unknown) => new Error(`${a.where}: docs[${i}]: ${(error as Error).message}`);
  const paths = cfg.docs.map((doc) => resolve(a.dir, doc));
  // file identity (device and inode), so a case variant on a case-insensitive file system or a link is a duplicate too
  const ids = paths.map((path, i) => {
    try {
      const st = statSync(path);
      return `${st.dev}:${st.ino}`;
    } catch (error) {
      throw docError(i, error);
    }
  });
  ids.forEach((id, j) => {
    const i = ids.indexOf(id);
    if (i !== j) throw new Error(`${a.where}: docs[${j}]: duplicate of docs[${i}]`);
  });
  return paths.map((path, i) => {
    try {
      return { path: cfg.docs[i], text: readFileSync(path, "utf8") };
    } catch (error) {
      throw docError(i, error);
    }
  });
}

// Built-in Markdown adapter: reads its documents.
const markdownAdapter = (a: Extract<Adapter, { kind: "markdown" }>): SourceFacts => markdownFacts(readDocs(a), a.config);

/**
 * The Markdown configuration of `avouch facts`: --adapter, else the `adapter` of the project configuration (--config, else
 * avouch.config.json at the git top level of the working directory). Reads no ontology. A module adapter is an error.
 */
export function resolveMarkdownAdapter(o: { config?: string; adapter?: string }): Extract<Adapter, { kind: "markdown" }> {
  if (o.config !== undefined && !isFile(o.config)) throw new Error(`--config ${o.config}: file not found`);
  let adapter: Adapter;
  if (o.adapter !== undefined) adapter = adapterFromArgument(o.adapter);
  else {
    const { config, top } = findProjectConfig(o.config, process.cwd());
    if (config === null) throw new Error(`facts: no adapter: pass --adapter, or set adapter in ${top !== null ? join(top, CONFIG_FILE) : CONFIG_FILE}; ${ADAPTER_HINT}`);
    if ("written" in config.adapter) {
      if (!isFile(config.adapter.path)) throw new Error(`${config.file}: adapter: file not found`);
      adapter = { ...adapterFromArgument(config.adapter.path), label: config.adapter.written };
    } else adapter = config.adapter;
  }
  if (adapter.kind !== "markdown") throw new Error("facts: the adapter must be a Markdown configuration");
  return adapter;
}

// Runs the JSON Schema validator and the checker on one ontology file with one adapter: a module that exports `facts`, or the
// configuration of the built-in Markdown adapter. Shared by `avouch check` and the `--check` of `query` and `gate verify`,
// so all report the same counts.
export async function runCheck(ontologyFile: string, adapter: Adapter): Promise<{ schemaErrors: ErrorObject[]; report: Report }> {
  const ontologyPath = resolve(ontologyFile);
  const schema = JSON.parse(readFileSync(new URL("../../ontology.schema.json", import.meta.url), "utf8"));
  const ontology: unknown = parse(readFileSync(ontologyPath, "utf8"));
  let facts: SourceFacts;
  if (adapter.kind === "markdown") facts = markdownAdapter(adapter);
  else {
    const mod = await import(pathToFileURL(adapter.path).href);
    if (typeof mod.facts !== "function") throw new Error("adapter must export a named facts function");
    facts = await mod.facts(ontologyPath);
  }
  const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema);
  validate(ontology);
  const schemaErrors = validate.errors ?? [];
  const report = check(ontology, facts);
  return { schemaErrors, report };
}

/** The `check` of a query or gate stamp: the check run with the adapter, or `not_run` when there is no adapter. */
export async function checkStamp(ontologyFile: string, adapter: Adapter | null): Promise<QueryStamp["check"]> {
  if (adapter === null) return { status: "not_run" };
  const { schemaErrors, report } = await runCheck(ontologyFile, adapter);
  const pass = schemaErrors.length === 0 && report.violations.length === 0;
  return { status: pass ? "pass" : "fail", adapter: adapter.label, schemaErrors: schemaErrors.length, violations: report.violations.length, waived: report.waived.length };
}

/** The project of a query or gate command: the check runs with --check, or with --adapter. */
export function resolveQueryProject(opts: Map<string, string | true>): { file: string; adapter: Adapter | null } {
  const adapter = opts.get("--adapter") as string | undefined;
  return resolveProject({ file: opts.get("-f") as string | undefined, config: opts.get("--config") as string | undefined, adapter, check: opts.get("--check") === true || adapter !== undefined });
}
