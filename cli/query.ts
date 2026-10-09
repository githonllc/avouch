import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isObj } from "../src/expr.js";
import {
  QUERY_LIST_KINDS,
  queryAction,
  queryCites,
  queryDisposition,
  queryList,
  queryObject,
  queryReads,
  queryWrites,
  type QueryEnvelope,
  type QueryStamp,
  type QueryVerb,
} from "../src/query.js";
import { runCheck } from "./check.js";

export const QUERY_USAGE = "usage: avouch query <list|action|object|result|writes|reads|cites> <arg> <ontology.yaml> [--json] [--adapter <module|config.json>]";
const VERBS: readonly QueryVerb[] = ["list", "action", "object", "result", "writes", "reads", "cites"];

// Read-only git commands, run from the directory of the ontology file. null when any of them fails.
function gitStamp(file: string): QueryStamp["git"] {
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["--no-optional-locks", ...args], { cwd: dirname(file), encoding: "utf8" });
    return r.error !== undefined || r.status !== 0 ? null : r.stdout;
  };
  const commit = git("rev-parse", "HEAD");
  const top = git("rev-parse", "--show-toplevel");
  const status = git("status", "--porcelain", "--", file);
  if (commit === null || top === null || status === null) return null;
  // status prints nothing for an ignored file; a file that is not tracked is in no commit, so it is dirty.
  const tracked = git("ls-files", "--error-unmatch", "--", file);
  return { commit: commit.trim(), dirty: status.trim() !== "" || tracked === null, path: relative(top.trim(), file).split(sep).join("/") };
}

function run(verb: QueryVerb, arg: string, ont: unknown): { result: unknown; empty: boolean } {
  switch (verb) {
    case "list": {
      const r = queryList(ont, arg);
      return { result: r, empty: r === null || r.items.length === 0 };
    }
    case "cites": {
      const r = queryCites(ont, arg);
      return { result: r, empty: r.claims.length === 0 };
    }
    default: {
      const f = { action: queryAction, object: queryObject, result: queryDisposition, writes: queryWrites, reads: queryReads }[verb];
      const r = f(ont, arg);
      return { result: r, empty: r === null };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- text

const isScalar = (x: unknown) => x === null || typeof x !== "object";
const isCite = (x: unknown): x is { doc: string; quote: string | null } =>
  isObj(x) && Object.keys(x).length === 2 && typeof x.doc === "string" && (typeof x.quote === "string" || x.quote === null);

// A scalar on one line: a line break becomes the two characters \n (or \r).
const esc = (x: unknown) => String(x).replace(/\n/g, "\\n").replace(/\r/g, "\\r");

// The one-line form of a value, or undefined when it needs a block.
function inline(v: unknown): string | undefined {
  if (v === null || v === undefined) return "-";
  if (typeof v !== "object") return esc(v);
  if (isCite(v)) return v.quote === null ? `[${esc(v.doc)}]` : `[${esc(v.doc)}] ${esc(v.quote)}`;
  if (Array.isArray(v)) {
    if (v.length === 0) return "-";
    return v.every(isScalar) ? v.map((x) => (x === null ? "-" : esc(x))).join(", ") : undefined;
  }
  return Object.keys(v).length === 0 ? "-" : undefined;
}

function block(v: unknown, pad: string): string[] {
  if (Array.isArray(v))
    return v.flatMap((el) => {
      const s = inline(el);
      if (s !== undefined) return [`${pad}- ${s}`];
      const sub = block(el, `${pad}  `);
      if (sub.length === 0) return [`${pad}- -`];
      return [`${pad}- ${sub[0].slice(pad.length + 2)}`, ...sub.slice(1)];
    });
  const o = v as Record<string, unknown>;
  return Object.keys(o)
    .filter((k) => !(k === "expr" && "exprText" in o))
    .flatMap((k) => {
      const s = inline(o[k]);
      return s !== undefined ? [`${pad}${k}: ${s}`] : [`${pad}${k}:`, ...block(o[k], `${pad}  `)];
    });
}

function text(env: QueryEnvelope): string {
  const { stamp } = env;
  const c = stamp.check;
  const lines = [
    `ontology: ${stamp.git?.path ?? stamp.ontology}`,
    stamp.git === null ? "commit: none (not in git)" : `commit: ${stamp.git.commit}${stamp.git.dirty ? " (dirty)" : ""}`,
    c.status === "not_run" ? "check: not_run" : `check: ${c.status} (${c.schemaErrors} schema error(s), ${c.violations} violation(s), ${c.waived} waived)`,
    "",
  ];
  const s = inline(env.result);
  return [...lines, ...(s !== undefined ? [s] : block(env.result, ""))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------- main

function parseArgs(args: string[]): { verb: QueryVerb; arg: string; file: string; json: boolean; adapter: string | null } {
  const pos: string[] = [];
  let json = false;
  let adapter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--adapter") {
      if (i + 1 >= args.length) throw new Error("--adapter needs a module");
      adapter = args[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 3) throw new Error(`expected 3 arguments, found ${pos.length}`);
  const [verb, arg, file] = pos;
  if (!(VERBS as readonly string[]).includes(verb)) throw new Error(`unknown verb ${verb}`);
  if (verb === "list" && !(QUERY_LIST_KINDS as readonly string[]).includes(arg)) throw new Error(`unknown list kind ${arg}`);
  if ((verb === "writes" || verb === "reads") && arg.split(".").length !== 2) throw new Error(`${verb} takes <Object>.<property>`);
  return { verb: verb as QueryVerb, arg, file, json, adapter };
}

async function query(args: string[]): Promise<number> {
  const { verb, arg, file, json, adapter } = parseArgs(args);
  const real = realpathSync(resolve(file));
  const ont: unknown = parse(readFileSync(real, "utf8"));
  if (!isObj(ont)) throw new Error(`${file}: the root is not a mapping`);
  let check: QueryStamp["check"] = { status: "not_run" };
  if (adapter !== null) {
    const { schemaErrors, report } = await runCheck(file, adapter);
    const pass = schemaErrors.length === 0 && report.violations.length === 0;
    check = { status: pass ? "pass" : "fail", adapter, schemaErrors: schemaErrors.length, violations: report.violations.length, waived: report.waived.length };
  }
  const { result, empty } = run(verb, arg, ont);
  const env: QueryEnvelope = { avouchQuery: 1, stamp: { ontology: real, git: gitStamp(real), check }, verb, arg, result };
  process.stdout.write(json ? `${JSON.stringify(env, null, 2)}\n` : text(env));
  return empty ? 1 : 0;
}

// Exit 0: a result; 1: no result (null or an empty list); 2: a usage, file, parse or adapter error (one stderr line).
export async function runQuery(args: string[]): Promise<number> {
  try {
    return await query(args);
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
    console.error(`${msg}; ${QUERY_USAGE}`);
    return 2;
  }
}
