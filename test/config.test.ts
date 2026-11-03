// The project configuration file avouch.config.json: validation, discovery, precedence, and when it is read.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseMarkdownConfig, validateMarkdownConfig } from "../src/markdown";
import { applyPatch } from "../src/patch";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli/avouch.js");
const libraryOntology = join(root, "examples/library/library.ontology.yaml");
const libraryDoc = join(root, "examples/library/library.md");
const strictAdapter = join(root, "test/fixtures/library-adapter.mjs");
const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/library-markdown.json"), "utf8"));
const directories: string[] = [];
const runIn = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
// with no git on the PATH: a lookup that runs git finds nothing
const runWithoutGit = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: cwd } });
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const gitAvailable = git(root, "--version").status === 0;
// A resolution error is exactly one stderr line (no usage line): the whole stderr is that line.
const first = (stderr: string) => {
  const lines = stderr.trimEnd().split("\n");
  expect(lines, stderr).toHaveLength(1);
  return lines[0];
};
const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1);

const directory = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "avouch-config-")));
  directories.push(d);
  return d;
};
const repository = () => {
  const d = directory();
  expect(git(d, "init", "-q").status).toBe(0);
  return d;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const writeJson = (path: string, value: unknown) => write(path, JSON.stringify(value));

// The clean toy ontology without evidence ids, with a waiver for the evidence that the Markdown adapter does not read.
const waived = () => {
  const o = parse(readFileSync(libraryOntology, "utf8"));
  for (const a of Object.values(o.actionTypes as Record<string, Record<string, unknown>>)) delete a.evidence;
  o.knownSourceGaps = [{ id: "NO-EVIDENCE", rule: "R6", kind: "fact_missing", keys: ["facts.evidence"], doc_line: "test", conflict: "test", proposed: "test" }];
  return stringify(o);
};
// The toy ontology with BORROW emitting an event that is not in the event catalog: rule R8 fails.
const badEvent = () => {
  const mutation = parse(readFileSync(join(root, "examples/library/mutations/lib-r8-unknown-event.yaml"), "utf8"));
  return stringify(applyPatch(parse(readFileSync(libraryOntology, "utf8")), mutation.patch));
};
const markdown = (extra: Record<string, unknown> = {}) => ({ ...fixture, docs: [libraryDoc], ...extra });
const ONTOLOGY = "avouch/avouch.ontology.yaml";
const CONFIG = "avouch.config.json";

// A repository with the waived toy ontology and a project configuration that uses the built-in Markdown adapter.
const markdownProject = () => {
  const top = repository();
  write(join(top, ONTOLOGY), waived());
  writeJson(join(top, CONFIG), { ontology: ONTOLOGY, adapter: { markdown: markdown() } });
  return top;
};
// A repository with the toy ontology that fails R8, and a project configuration with a module that switches R8 off.
const lenientProject = () => {
  const top = repository();
  write(join(top, ONTOLOGY), badEvent());
  write(
    join(top, "tools/lenient.mjs"),
    `import { facts as base } from ${JSON.stringify(pathToFileURL(strictAdapter).href)};\n` +
      `export const facts = (o) => { const f = base(o); return { ...f, config: { ...f.config, rules: { ...f.config.rules, R8: { disabled: "test" } } } }; };\n`,
  );
  writeJson(join(top, CONFIG), { ontology: ONTOLOGY, adapter: { module: "tools/lenient.mjs" } });
  return top;
};

afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nonGit = directory();
directories.length = 0;
afterAll(() => rmSync(nonGit, { recursive: true, force: true }));
const outsideGit = git(nonGit, "rev-parse", "--show-toplevel").status !== 0;

describe("validateMarkdownConfig and parseMarkdownConfig", () => {
  it("validateMarkdownConfig takes a parsed value and the prefix of the error", () => {
    expect(validateMarkdownConfig({ docs: ["a.md"] }, "w").docs).toEqual(["a.md"]);
    expect(() => validateMarkdownConfig({}, "c.json: adapter.markdown")).toThrow("c.json: adapter.markdown: docs: missing");
    expect(() => validateMarkdownConfig([], "w")).toThrow("w: (root): must be an object");
    expect(() => validateMarkdownConfig({ docs: ["a.md"], x: 1 }, "w")).toThrow("w: x: unknown key");
  });

  it("parseMarkdownConfig keeps its signature and its messages", () => {
    expect(parseMarkdownConfig('{"docs":["a.md"]}', "c.json").docs).toEqual(["a.md"]);
    expect(() => parseMarkdownConfig("{", "c.json")).toThrow(/^c\.json: \(root\): not valid JSON/);
    expect(() => parseMarkdownConfig("{}", "c.json")).toThrow("c.json: docs: missing");
  });
});

describe("avouch.config.json: validation", () => {
  const cases: [string, unknown, string][] = [
    ["not JSON", "{", "(root): not valid JSON"],
    ["an array", [], "(root): must be an object"],
    ["an unknown key", { ontology: "o.yaml", adapter: { module: "m.mjs" }, extra: 1 }, "extra: unknown key"],
    ["no ontology", { adapter: { module: "m.mjs" } }, "ontology: missing"],
    ["empty ontology", { ontology: "", adapter: { module: "m.mjs" } }, "ontology: must be a non-empty string"],
    ["ontology not a string", { ontology: 5, adapter: { module: "m.mjs" } }, "ontology: must be a non-empty string"],
    ["no adapter", { ontology: "o.yaml" }, "adapter: missing"],
    ["adapter an array", { ontology: "o.yaml", adapter: [] }, "adapter: must be an object"],
    ["adapter a string", { ontology: "o.yaml", adapter: "m.mjs" }, "adapter: must be an object"],
    ["adapter empty", { ontology: "o.yaml", adapter: {} }, 'adapter: must have exactly one of "markdown" and "module"'],
    ["adapter with both", { ontology: "o.yaml", adapter: { module: "m.mjs", markdown: { docs: ["a.md"] } } }, 'adapter: must have exactly one of "markdown" and "module"'],
    ["unknown adapter key", { ontology: "o.yaml", adapter: { module: "m.mjs", other: 1 } }, "adapter.other: unknown key"],
    ["empty module", { ontology: "o.yaml", adapter: { module: "" } }, "adapter.module: must be a non-empty string"],
    ["module not a string", { ontology: "o.yaml", adapter: { module: ["m.mjs"] } }, "adapter.module: must be a non-empty string"],
    ["markdown not an object", { ontology: "o.yaml", adapter: { markdown: "x.json" } }, "adapter.markdown: must be an object"],
    ["markdown without docs", { ontology: "o.yaml", adapter: { markdown: {} } }, "adapter.markdown: docs: missing"],
    ["markdown with an unknown key", { ontology: "o.yaml", adapter: { markdown: { docs: ["a.md"], extra: 1 } } }, "adapter.markdown: extra: unknown key"],
    ["markdown with a duplicate doc", { ontology: "o.yaml", adapter: { markdown: { docs: ["a.md", "a.md"] } } }, "adapter.markdown: docs[1]: duplicate of docs[0]"],
    ["markdown with an unknown fact", { ontology: "o.yaml", adapter: { markdown: { docs: ["a.md"], facts: { x: "L1" } } } }, "adapter.markdown: facts.x: unknown key"],
    ["markdown with an unknown rule", { ontology: "o.yaml", adapter: { markdown: { docs: ["a.md"], profile: { rules: { R99: true } } } } }, "adapter.markdown: profile.rules.R99: unknown rule"],
    ["markdown with a bad pattern", { ontology: "o.yaml", adapter: { markdown: { docs: ["a.md"], profile: { actionIdPattern: "(" } } } }, "adapter.markdown: profile.actionIdPattern: invalid regular expression"],
  ];

  it.each(cases)("%s: exit 2 and <file>: <json path>: <problem>", (_name, value, message) => {
    const d = directory();
    const file = write(join(d, "bad.json"), typeof value === "string" ? value : JSON.stringify(value));
    for (const args of [["check", "--config", file], ["query", "list", "actions", "--config", file], ["reconcile", "--config", file, "--cases", "x.jsonl"], ["gate", "verify", "--config", file, "--rows", "x.jsonl"]]) {
      const r = runIn(d, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(`${file}: ${message}`);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });

  it("a valid configuration of each adapter kind is accepted", () => {
    const top = markdownProject();
    const r = runIn(top, "check", "--config", join(top, CONFIG));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lenient = lenientProject();
    const l = runIn(lenient, "check", "--config", join(lenient, CONFIG));
    expect(l.status, l.stdout + l.stderr).toBe(0);
  });
});

describe.skipIf(!gitAvailable)("discovery", () => {
  it("no -f, no --config: the avouch.config.json at the git top level, from a subdirectory, with its ontology", () => {
    const top = repository();
    write(join(top, "specs/o.yaml"), waived());
    // a default file that must not be used
    write(join(top, ONTOLOGY), "not: the ontology\n");
    writeJson(join(top, CONFIG), { ontology: "specs/o.yaml", adapter: { markdown: markdown() } });
    mkdirSync(join(top, "src/deep"), { recursive: true });
    const r = runIn(join(top, "src/deep"), "check");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
  });

  it("--config <file>: paths are relative to the file, the file is relative to the working directory", () => {
    const top = repository();
    write(join(top, "specs/o.yaml"), waived());
    writeJson(join(top, "conf/x.json"), { ontology: "../specs/o.yaml", adapter: { markdown: markdown({ docs: [relative(join(top, "conf"), libraryDoc)] }) } });
    mkdirSync(join(top, "sub"));
    const r = runIn(join(top, "sub"), "check", "--config", "../conf/x.json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
  });

  it("--config outside any git repository", (ctx) => {
    if (!outsideGit) ctx.skip();
    const d = directory();
    write(join(d, "o.yaml"), waived());
    writeJson(join(d, "c.json"), { ontology: "o.yaml", adapter: { markdown: markdown() } });
    const r = runIn(d, "check", "--config", "c.json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("--config of a missing file: exit 2, and no fallback to the avouch.config.json at the top", () => {
    const top = markdownProject();
    for (const args of [
      ["check", "--config", "nope.json"],
      ["query", "list", "actions", "--config", "nope.json"],
      ["reconcile", "--config", "nope.json", "--cases", "x.jsonl"],
      ["gate", "verify", "--config", "nope.json", "--rows", "x.jsonl"],
    ]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain("--config nope.json: file not found");
    }
  });

  it("-f into another git repository: the configuration of that repository, not of the working directory", () => {
    const here = lenientProject();
    const other = markdownProject();
    const r = runIn(here, "check", "-f", join(other, ONTOLOGY));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
  });

  it("-f in a directory outside git, working directory inside a repository with a configuration: no configuration", (ctx) => {
    if (!outsideGit) ctx.skip();
    const here = markdownProject();
    const d = directory();
    const ontology = write(join(d, "o.yaml"), waived());
    const r = runIn(here, "check", "-f", ontology);
    expect(r.status).toBe(2);
    expect(first(r.stderr)).toBe("no adapter: pass --adapter, or set adapter in avouch.config.json");
    expect(r.stderr).not.toContain("git repository");
  });

  it("no walk-up: a configuration above the git top level is not found", (ctx) => {
    if (!outsideGit) ctx.skip();
    const parent = directory();
    writeJson(join(parent, CONFIG), { ontology: "o.yaml", adapter: { markdown: markdown() } });
    const inner = join(parent, "repo");
    mkdirSync(inner);
    expect(git(inner, "init", "-q").status).toBe(0);
    const ontology = write(join(inner, "o.yaml"), waived());
    const r = runIn(inner, "check", "-f", ontology);
    expect(r.status).toBe(2);
    expect(first(r.stderr)).toBe(`no adapter: pass --adapter, or set adapter in ${join(inner, CONFIG)}`);
  });

  it("no configuration of a subdirectory is read: only the git top level counts", () => {
    const top = repository();
    write(join(top, ONTOLOGY), waived());
    writeJson(join(top, "sub", CONFIG), { ontology: `../${ONTOLOGY}`, adapter: { markdown: markdown() } });
    const r = runIn(join(top, "sub"), "check");
    expect(r.status).toBe(2);
    expect(first(r.stderr)).toBe(`no adapter: pass --adapter, or set adapter in ${join(top, CONFIG)}`);
  });
});

describe.skipIf(!gitAvailable)("errors", () => {
  it("no -f, no configuration, and no default ontology", () => {
    const top = repository();
    for (const args of [["check"], ["query", "list", "actions"], ["reconcile", "--cases", "x.jsonl"], ["gate", "verify", "--rows", "x.jsonl"]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(`no -f, no ${CONFIG} at ${top}, and ${join(top, ONTOLOGY)} does not exist`);
    }
  });

  it("no -f and no --config, outside git", (ctx) => {
    if (!outsideGit) ctx.skip();
    for (const args of [["check"], ["query", "list", "actions"], ["reconcile", "--cases", "x.jsonl"], ["gate", "verify", "--rows", "x.jsonl"]]) {
      const r = runIn(nonGit, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain("no -f and no --config, and the working directory is not in a git repository");
    }
  });

  it("no adapter: check, and query and gate with --check", () => {
    const top = repository();
    write(join(top, ONTOLOGY), waived());
    for (const args of [["check"], ["query", "list", "actions", "--check"], ["gate", "verify", "--rows", write(join(top, "rows.jsonl"), ""), "--check"]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(`no adapter: pass --adapter, or set adapter in ${join(top, CONFIG)}`);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });

  it("-f given, no check needed, outside git: not an error", (ctx) => {
    if (!outsideGit) ctx.skip();
    const ontology = write(join(directory(), "o.yaml"), waived());
    const r = runIn(nonGit, "query", "list", "actions", "-f", ontology);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe.skipIf(!gitAvailable)("precedence", () => {
  it("the ontology: -f over the ontology of the configuration, which is over the default", () => {
    const top = repository();
    write(join(top, ONTOLOGY), stringify({ ...parse(waived()), id: "default" }));
    write(join(top, "specs/o.yaml"), waived());
    writeJson(join(top, CONFIG), { ontology: "specs/o.yaml", adapter: { markdown: markdown() } });
    const other = write(join(top, "other.yaml"), readFileSync(libraryOntology, "utf8"));
    const ids = (args: string[]) => {
      const r = runIn(top, "query", "list", "actions", "--json", ...args);
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout).stamp.ontology as string;
    };
    expect(ids([])).toBe(join(top, "specs/o.yaml"));
    expect(ids(["-f", other])).toBe(other);
    // without a configuration: the default
    rmSync(join(top, CONFIG));
    expect(ids([])).toBe(join(top, ONTOLOGY));
  });

  it("the adapter: --adapter over the configuration", () => {
    const top = lenientProject();
    const byConfig = runIn(top, "check");
    expect(byConfig.status, byConfig.stdout + byConfig.stderr).toBe(0);
    const byArgument = runIn(top, "check", "--adapter", strictAdapter);
    expect(byArgument.status, byArgument.stdout).toBe(1);
    expect(byArgument.stdout).toContain("FAIL R8 ");
    const withF = runIn(top, "check", "-f", join(top, ONTOLOGY), "--adapter", strictAdapter);
    expect(withF.status).toBe(1);
    expect(withF.stdout).toBe(byArgument.stdout);
  });
});

describe.skipIf(!gitAvailable)("-f and the configuration", () => {
  it("-f is not the ontology of the configuration, no --adapter: exit 2", () => {
    const top = markdownProject();
    write(join(top, "other.yaml"), waived());
    for (const args of [["check", "-f", "other.yaml"], ["query", "list", "actions", "-f", "other.yaml", "--check"], ["gate", "verify", "-f", "other.yaml", "--rows", write(join(top, "rows.jsonl"), ""), "--check"]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(`-f other.yaml is not the ontology in ${join(top, CONFIG)} (${join(top, ONTOLOGY)}): pass --adapter`);
    }
  });

  it("the same file written with another path, or through a link: no error", () => {
    const top = markdownProject();
    symlinkSync(join(top, ONTOLOGY), join(top, "link.yaml"));
    const results = [
      ["check", "-f", ONTOLOGY],
      ["check", "-f", `./avouch/../${ONTOLOGY}`],
      ["check", "-f", join(top, ONTOLOGY)],
      ["check", "-f", "link.yaml"],
    ].map((args) => runIn(top, ...args));
    for (const r of results) {
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toBe(results[0].stdout);
    }
  });

  it("with --adapter, a different -f is allowed", () => {
    const top = markdownProject();
    const other = write(join(top, "other.yaml"), readFileSync(libraryOntology, "utf8"));
    const r = runIn(top, "check", "-f", other, "--adapter", strictAdapter);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe.skipIf(!gitAvailable)("when the configuration is read", () => {
  // a repository with a configuration that is not valid JSON
  const brokenProject = () => {
    const top = repository();
    write(join(top, CONFIG), "{ not json");
    return top;
  };

  it("query -f and gate verify -f, without --check: a broken configuration is not read", () => {
    const rows = write(join(directory(), "rows.jsonl"), "");
    const broken = brokenProject();
    const clean = repository();
    for (const args of [["query", "list", "actions", "-f", libraryOntology], ["gate", "verify", "-f", libraryOntology, "--rows", rows]]) {
      const a = runIn(broken, ...args);
      const b = runIn(clean, ...args);
      expect(a.stderr, args.join(" ")).toBe(b.stderr);
      expect(a.status, args.join(" ")).toBe(b.status);
      expect(a.stdout.replace(/commit: .*/g, ""), args.join(" ")).toBe(b.stdout.replace(/commit: .*/g, ""));
      expect(a.status, args.join(" ")).not.toBe(2);
    }
  });

  it("-f with --adapter: a broken configuration is not read, for check, query and gate", () => {
    const rows = write(join(directory(), "rows.jsonl"), "");
    const broken = brokenProject();
    const clean = repository();
    for (const args of [
      ["check", "-f", libraryOntology, "--adapter", strictAdapter],
      ["query", "list", "actions", "-f", libraryOntology, "--adapter", strictAdapter],
      ["gate", "verify", "-f", libraryOntology, "--rows", rows, "--adapter", strictAdapter],
    ]) {
      const a = runIn(broken, ...args);
      const b = runIn(clean, ...args);
      expect(a.stderr, args.join(" ")).toBe(b.stderr);
      expect(a.status, args.join(" ")).toBe(b.status);
      expect(a.stdout.replace(/commit: .*/g, ""), args.join(" ")).toBe(b.stdout.replace(/commit: .*/g, ""));
      expect(a.status, args.join(" ")).not.toBe(2);
    }
  });

  it("-f with --adapter, outside git: the same output as inside a repository", (ctx) => {
    if (!outsideGit) ctx.skip();
    const rows = write(join(directory(), "rows.jsonl"), "");
    const clean = repository();
    for (const args of [
      ["check", "-f", libraryOntology, "--adapter", strictAdapter],
      ["query", "list", "actions", "-f", libraryOntology, "--adapter", strictAdapter],
      ["gate", "verify", "-f", libraryOntology, "--rows", rows, "--adapter", strictAdapter],
    ]) {
      const a = runIn(nonGit, ...args);
      const b = runIn(clean, ...args);
      expect(a.status, args.join(" ") + a.stderr).toBe(b.status);
      expect(a.status, args.join(" ")).not.toBe(2);
      expect(a.stdout, args.join(" ")).toBe(b.stdout);
    }
  });

  it("--check reads the configuration, so a broken one is an error", () => {
    const broken = brokenProject();
    const ontology = write(join(broken, ONTOLOGY), waived());
    for (const args of [["query", "list", "actions", "-f", ontology, "--check"], ["check", "-f", ontology]]) {
      const r = runIn(broken, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(`${join(broken, CONFIG)}: (root): not valid JSON`);
    }
  });

  it("without -f, the configuration is always read", () => {
    const broken = brokenProject();
    const r = runIn(broken, "query", "list", "actions");
    expect(r.status).toBe(2);
    expect(first(r.stderr)).toContain(`${join(broken, CONFIG)}: (root): not valid JSON`);
  });
});

describe.skipIf(!gitAvailable)("one stderr line for a resolution error", () => {
  it("check: every resolution error is one line, without the usage line", () => {
    const top = repository();
    const oldLayout = repository();
    write(join(oldLayout, ONTOLOGY), waived());
    writeJson(join(oldLayout, "avouch/avouch.json"), markdown());
    const mismatch = markdownProject();
    write(join(mismatch, "other.yaml"), waived());
    const badAdapter = markdownProject();
    write(join(badAdapter, "bad.json"), "{");
    const badConfig = repository();
    write(join(badConfig, CONFIG), "{ not json");
    const cases: [string, string[], string][] = [
      [top, ["check"], "does not exist"],
      [oldLayout, ["check"], "no adapter"],
      [mismatch, ["check", "-f", "other.yaml"], "is not the ontology in"],
      [badAdapter, ["check", "--adapter", "bad.json"], "bad.json"],
      [badAdapter, ["check", "-f", ONTOLOGY, "--adapter", "nope.json"], "nope.json"],
      [badConfig, ["check"], "not valid JSON"],
      [top, ["check", "--config", "nope.json"], "--config nope.json: file not found"],
    ];
    for (const [cwd, args, message] of cases) {
      const r = runIn(cwd, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(first(r.stderr), args.join(" ")).toContain(message);
      expect(r.stderr, args.join(" ")).not.toContain("usage:");
    }
  });

  it("check: an option error keeps the usage line", () => {
    const r = runIn(directory(), "check", "--frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(2);
    expect(r.stderr).toContain("unknown option --frobnicate");
    expect(r.stderr).toContain("usage: avouch check");
  });
});

describe.skipIf(!gitAvailable)("a named file that does not exist", () => {
  it("--config of a missing file is an error also when the configuration is not read", () => {
    const top = repository();
    const rows = write(join(top, "rows.jsonl"), "");
    for (const args of [
      ["query", "list", "actions", "-f", libraryOntology, "--config", "typo.json"],
      ["query", "list", "actions", "-f", libraryOntology, "--adapter", strictAdapter, "--config", "typo.json"],
      ["check", "-f", libraryOntology, "--adapter", strictAdapter, "--config", "typo.json"],
      ["gate", "verify", "-f", libraryOntology, "--rows", rows, "--config", "typo.json"],
      ["gate", "verify", "-f", libraryOntology, "--rows", rows, "--adapter", strictAdapter, "--config", "typo.json"],
      ["reconcile", "-f", libraryOntology, "--cases", rows, "--config", "typo.json"],
    ]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toContain("--config typo.json: file not found");
    }
  });

  it("the check is a stat, not a parse and not a git call", () => {
    const d = directory();
    const r = runWithoutGit(d, "query", "list", "actions", "-f", libraryOntology, "--adapter", strictAdapter, "--config", "typo.json");
    expect(r.status).toBe(2);
    expect(first(r.stderr)).toContain("--config typo.json: file not found");
    // an existing --config that is not read is not parsed either
    const broken = write(join(d, "broken.json"), "{ not json");
    const ok = runWithoutGit(d, "query", "list", "actions", "-f", libraryOntology, "--config", broken);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("the ontology of the configuration does not exist: <config file>: ontology: file not found", () => {
    const top = repository();
    writeJson(join(top, CONFIG), { ontology: "nope/o.yaml", adapter: { markdown: markdown() } });
    for (const args of [["check"], ["query", "list", "actions"], ["gate", "verify", "--rows", write(join(top, "rows.jsonl"), "")], ["reconcile", "--cases", write(join(top, "cases.jsonl"), "")]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      // query, gate and reconcile append the usage to their one line
      expect(first(r.stderr), args.join(" ")).toMatch(new RegExp(`^${`${join(top, CONFIG)}: ontology: file not found`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(; usage: |$)`));
    }
  });

  it("-f of a missing file is an error before any git lookup", () => {
    const top = markdownProject();
    for (const args of [["check", "-f", "nodir/o.yaml"], ["check", "-f", "nodir/o.yaml", "--adapter", strictAdapter], ["query", "list", "actions", "-f", "nodir/o.yaml"], ["query", "list", "actions", "-f", "nodir/o.yaml", "--check"]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain("-f nodir/o.yaml: file not found");
      const g = runWithoutGit(top, ...args);
      expect(g.status, args.join(" ")).toBe(2);
      expect(first(g.stderr), args.join(" ")).toContain("-f nodir/o.yaml: file not found");
    }
  });
});

describe.skipIf(!gitAvailable)("the old avouch.json", () => {
  it("no adapter: the message points at the migration", () => {
    const top = repository();
    write(join(top, ONTOLOGY), waived());
    writeJson(join(top, "avouch/avouch.json"), markdown());
    const old = join(top, "avouch/avouch.json");
    for (const args of [["check"], ["query", "list", "actions", "--check"]]) {
      const r = runIn(top, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(first(r.stderr), args.join(" ")).toContain(
        `no adapter: pass --adapter, or set adapter in ${join(top, CONFIG)}; ${old} is no longer read: move it to adapter.markdown in ${CONFIG}, or pass --adapter ${old}`,
      );
    }
  });

  it("the file named by --adapter still works", () => {
    const top = repository();
    write(join(top, ONTOLOGY), waived());
    writeJson(join(top, "avouch/avouch.json"), markdown());
    const r = runIn(top, "check", "--adapter", "avouch/avouch.json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe.skipIf(!gitAvailable)("--check, --config and the stamp", () => {
  it("query --check uses the adapter of the configuration; the stamp names its source", () => {
    const top = markdownProject();
    const r = runIn(top, "query", "list", "actions", "--check", "--json");
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.avouchQuery).toBe(1);
    expect(env.stamp.check).toEqual({ status: "pass", adapter: `${join(top, CONFIG)}#adapter`, schemaErrors: 0, violations: 0, waived: 1 });
    const text = runIn(top, "query", "list", "actions", "--check");
    expect(text.stdout).toContain("check: pass (0 schema error(s), 0 violation(s), 1 waived)");
  });

  it("query --check with a module: the stamp holds the path of the module", () => {
    const top = lenientProject();
    const r = runIn(top, "query", "list", "actions", "--check", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).stamp.check).toMatchObject({ status: "pass", adapter: join(top, "tools/lenient.mjs") });
  });

  it("query --adapter keeps the argument as the stamp value", () => {
    const top = markdownProject();
    const r = runIn(top, "query", "list", "actions", "--adapter", strictAdapter, "--json");
    expect(JSON.parse(r.stdout).stamp.check.adapter).toBe(strictAdapter);
  });

  it("without --check and --adapter, the stamp stays not_run, whatever the configuration", () => {
    const top = markdownProject();
    const r = runIn(top, "query", "list", "actions", "--json");
    expect(JSON.parse(r.stdout).stamp.check).toEqual({ status: "not_run" });
  });

  it("gate verify --check runs the check of the configuration", () => {
    const top = lenientProject();
    const rows = write(join(top, "rows.jsonl"), "");
    const ok = runIn(top, "gate", "verify", "--rows", rows, "--check", "--json");
    const env = JSON.parse(ok.stdout);
    expect(env.avouchGate).toBe(1);
    expect(env.check).toMatchObject({ status: "pass", adapter: join(top, "tools/lenient.mjs") });
    const strict = runIn(top, "gate", "verify", "--rows", rows, "--adapter", strictAdapter, "--json");
    expect(JSON.parse(strict.stdout).check.status).toBe("fail");
  });

  it("reconcile --config takes the ontology of the file", () => {
    const top = repository();
    write(join(top, "specs/o.yaml"), waived());
    writeJson(join(top, "conf/x.json"), { ontology: "../specs/o.yaml", adapter: { markdown: markdown() } });
    const cases = write(join(top, "cases.jsonl"), "");
    const r = runIn(top, "reconcile", "--config", "conf/x.json", "--cases", cases);
    expect(r.status, r.stderr).toBe(0);
    const missing = runIn(top, "reconcile", "--cases", cases);
    expect(missing.status).toBe(2);
  });

  it("the usage lines name --config, and --check for query and gate", () => {
    const r = runIn(root, "frobnicate");
    expect(r.status).toBe(2);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toContain("--config <avouch.config.json>");
    expect(lines[1]).toContain("[--check]");
    expect(lines[3]).toContain("[--check]");
  });
});

describe.skipIf(!gitAvailable)("equivalence of the configuration and the command line", () => {
  it("the Markdown adapter: no arguments gives the output of -f with --adapter <avouch.json>", () => {
    const top = markdownProject();
    const legacy = writeJson(join(top, "legacy/avouch.json"), markdown());
    const byConfig = runIn(top, "check");
    const byArguments = runIn(top, "check", "-f", join(top, ONTOLOGY), "--adapter", legacy);
    expect(byConfig.status, byConfig.stdout + byConfig.stderr).toBe(0);
    expect(byConfig.status).toBe(byArguments.status);
    expect(byConfig.stdout).toBe(byArguments.stdout);
  });

  it("the module adapter: no arguments gives the output of -f with --adapter <module>", () => {
    for (const ontology of [readFileSync(libraryOntology, "utf8"), badEvent()]) {
      const top = repository();
      write(join(top, ONTOLOGY), ontology);
      // the module is the fixture of this checkout, named by a path relative to the configuration
      writeJson(join(top, CONFIG), { ontology: ONTOLOGY, adapter: { module: relative(top, strictAdapter) } });
      const byConfig = runIn(top, "check");
      const byArguments = runIn(top, "check", "-f", join(top, ONTOLOGY), "--adapter", strictAdapter);
      expect(byConfig.status).toBe(byArguments.status);
      expect(byConfig.stdout).toBe(byArguments.stdout);
      expect(lastLine(byConfig.stdout)).toMatch(/^(PASS|FAIL): /);
    }
  });
});
