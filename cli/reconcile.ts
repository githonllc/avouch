import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { isObj, type Stage1Ontology } from "../src/expr.js";
import { reconcile, type RuntimeCase } from "../src/reconcile.js";
import { ontologyFile } from "./check.js";
import { jsonLines } from "./jsonl.js";

export const RECONCILE_USAGE = "usage: avouch reconcile [-f <ontology.yaml>] --cases <cases.jsonl>";

const REASONS = ["missing", "unknown_param", "type", "not_found"];

// Options in any position. Returns the positional arguments and the value of each option.
export function parseOptions(args: string[], values: readonly string[], flags: readonly string[]): { pos: string[]; opts: Map<string, string | true> } {
  const pos: string[] = [];
  const opts = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (opts.has(a)) throw new Error(`repeated option ${a}`);
    if (flags.includes(a)) opts.set(a, true);
    else if (values.includes(a)) {
      if (i + 1 >= args.length || args[i + 1] === "") throw new Error(`${a} needs a file`);
      opts.set(a, args[++i]);
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, opts };
}

// Exactly n positional arguments. A word of the old form (an ontology file as an argument) gets a pointer to -f.
export function expectPositionals(pos: string[], n: number): void {
  if (pos.length === n) return;
  const old = pos.find((a) => /\.ya?ml$/.test(a));
  throw new Error(old !== undefined ? `unexpected argument ${old}: give the ontology with -f` : `expected ${n} argument(s), found ${pos.length}`);
}

export function readOntology(file: string): Record<string, unknown> {
  const ont: unknown = parse(readFileSync(resolve(file), "utf8"));
  if (!isObj(ont)) throw new Error(`${file}: the root is not a mapping`);
  return ont;
}

// The shape of a RuntimeCase (SPEC section 9). Extra keys are allowed; the snapshot content is not checked.
function checkCase(x: unknown): string | null {
  if (!isObj(x)) return "case is not an object";
  const c = x as Record<string, any>;
  if (typeof c.id !== "string" || c.id === "") return "id is not a non-empty string";
  if (typeof c.action !== "string" || c.action === "") return "action is not a non-empty string";
  if (!Object.hasOwn(c, "snapshot")) return "snapshot is missing";
  if (c.snapshot !== null && !isObj(c.snapshot)) return "snapshot is not null or an object";
  const i = c.inputs;
  if (!isObj(i)) return "inputs is not an object";
  if (!isObj(i.bindings)) return "inputs.bindings is not an object";
  if (!isObj(i.actor)) return "inputs.actor is not an object";
  if (typeof i.actor.id !== "string") return "inputs.actor.id is not a string";
  if (typeof i.actor.kind !== "string") return "inputs.actor.kind is not a string";
  if (!Array.isArray(i.actor.keys) || !i.actor.keys.every((k: unknown) => typeof k === "string")) return "inputs.actor.keys is not a list of strings";
  if (i.scope !== null && typeof i.scope !== "string") return "inputs.scope is not a string or null";
  if (typeof i.now !== "number" || !Number.isFinite(i.now)) return "inputs.now is not a finite number";
  for (const k of ["reported", "expected"]) {
    if (!Object.hasOwn(c, k)) return `${k} is missing`;
    const r = c[k];
    if (r === null) continue;
    if (!isObj(r)) return `${k} is not null or an object`;
    if (typeof r.result !== "string" || r.result === "") return `${k}.result is not a non-empty string`;
    if (r.reason !== undefined && !REASONS.includes(r.reason)) return `${k}.reason is not one of ${REASONS.join(", ")}`;
  }
  return null;
}

async function main(args: string[]): Promise<number> {
  const { pos, opts } = parseOptions(args, ["-f", "--cases"], []);
  expectPositionals(pos, 0);
  const cases = opts.get("--cases");
  if (typeof cases !== "string") throw new Error("--cases is required");
  const ont = readOntology(ontologyFile(opts.get("-f") as string | undefined));
  const lines = jsonLines(cases);
  for (const { line, value } of lines) {
    const problem = checkCase(value);
    if (problem !== null) throw new Error(`${cases}:${line}: ${problem}`);
  }
  const rows = reconcile(ont as unknown as Stage1Ontology, lines.map((x) => x.value as RuntimeCase));
  process.stdout.write(rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return 0;
}

// Exit 0: one row per case (the command does not judge the rows); 2: a usage, file, parse or shape error (one stderr line).
export async function runReconcile(args: string[]): Promise<number> {
  try {
    return await main(args);
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
    console.error(`${msg}; ${RECONCILE_USAGE}`);
    return 2;
  }
}
