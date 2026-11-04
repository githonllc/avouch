import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isObj } from "../src/expr.js";
import { markdownFacts, markdownTextBlocks, type MarkdownConfig } from "../src/markdown.js";
import type { SourceFacts } from "../src/contract.js";
import { readDocs, resolveMarkdownAdapter } from "./check.js";
import { expectPositionals, parseOptions, wantsHelp } from "./reconcile.js";

export const FACTS_USAGE = "usage: avouch facts [--config <avouch.config.json>] [--adapter <config.json>] [--json] [--inventory <file.json>]";

const NAMES = ["storeCatalog", "eventCatalog", "contextMembers", "permissions", "scenarios", "stateMachines", "transitionTriggers"] as const;
type Name = (typeof NAMES)[number];

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const byKey = <T>(entries: Iterable<[string, T]>): Record<string, T> => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A configured fact: the `FACT` lines and the JSON value (Sets as sorted arrays, Maps as objects with sorted keys), or null when it is not configured. */
function describeFact(name: Name, facts: SourceFacts, config: MarkdownConfig): { lines: string[]; json: unknown } | null {
  const line = (anchor: string, text: string, object = "") => `FACT ${name}${object} ${anchor}: ${text}`;
  const anchor = name === "stateMachines" ? "" : config.facts[name as Exclude<Name, "stateMachines">];
  if (name === "stateMachines" ? facts.stateMachines === undefined : anchor === undefined) return null;
  switch (name) {
    case "storeCatalog":
    case "eventCatalog": {
      const x = facts[name]!.value;
      return { lines: [line(anchor!, `${x.size} names`)], json: sorted(x) };
    }
    case "contextMembers": {
      const x = facts.contextMembers!;
      return { lines: [line(anchor!, `${x.size} contexts`)], json: byKey([...x].map(([c, m]) => [c, sorted(m.value)])) };
    }
    case "permissions": {
      const x = facts.permissions!;
      return {
        lines: [line(anchor!, `${x.catalog.value.size} catalog names, ${x.rows.value.size} rows`)],
        json: { catalog: sorted(x.catalog.value), rows: byKey([...x.rows.value].map(([n, r]) => [n, sorted(r.keys)])) },
      };
    }
    case "scenarios": {
      const x = facts.scenarios!;
      return { lines: [line(anchor!, `${x.ids.size} scenarios`)], json: byKey([...x.cites].map(([id, c]) => [id, sorted(c)])) };
    }
    case "stateMachines": {
      const x = facts.stateMachines!;
      return {
        lines: [...x].map(([o, m]) => line(m.source.anchor, m.value === null ? "null" : `${m.value.nodes.length} states, ${m.value.edges.length} edges`, `.${o}`)),
        json: byKey([...x].map(([o, m]) => [o, m.value === null ? null : { nodes: sorted(m.value.nodes), initial: sorted(m.value.initial), edges: sorted(m.value.edges) }])),
      };
    }
    case "transitionTriggers": {
      const x = facts.transitionTriggers!;
      const edges = [...x.values()].reduce((n, m) => n + m.size, 0);
      return { lines: [line(anchor!, `${edges} edges`)], json: byKey([...x].map(([o, m]) => [o, byKey([...m].map(([e, t]) => [e, sorted(t.value)]))])) };
    }
  }
}

const show = (x: unknown): string => (x === undefined ? "(absent)" : JSON.stringify(x));

/** Differences between the inventory and the parse result, one `DIFF <path>: inventory <x>, document <y>` line each. An array is compared as a set of strings. */
function diff(path: string, inv: unknown, doc: unknown, out: string[]): void {
  if (Array.isArray(inv) && Array.isArray(doc) && inv.every((x) => typeof x === "string") && doc.every((x) => typeof x === "string")) {
    if (JSON.stringify(sorted(inv)) !== JSON.stringify(sorted(doc))) out.push(`DIFF ${path}: inventory ${show(sorted(inv))}, document ${show(sorted(doc))}`);
  } else if (isObj(inv) && isObj(doc)) {
    for (const k of sorted(new Set([...Object.keys(inv), ...Object.keys(doc)]))) diff(`${path}.${k}`, inv[k], doc[k], out);
  } else if (JSON.stringify(inv) !== JSON.stringify(doc)) out.push(`DIFF ${path}: inventory ${show(inv)}, document ${show(doc)}`);
}

/** The inventory file: `{"conventionVersion": 1, "facts": {...}, "fields": {...}, "prose": [...]}`. Throws on any other shape. */
function readInventory(file: string): { facts: Record<string, unknown>; fields: Record<string, unknown> } {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    return fail(`not valid JSON: ${(error as Error).message}`);
  }
  if (!isObj(raw)) return fail("the root must be an object");
  for (const k of Object.keys(raw)) if (!["conventionVersion", "facts", "fields", "prose"].includes(k)) fail(`${k}: unknown key`);
  if (raw.conventionVersion !== 1) fail("conventionVersion: must be 1");
  if (!isObj(raw.facts)) fail("facts: must be an object");
  if (!isObj(raw.fields)) fail("fields: must be an object");
  if (!Array.isArray(raw.prose)) fail("prose: must be an array");
  return { facts: raw.facts as Record<string, unknown>, fields: raw.fields as Record<string, unknown> };
}

/** `avouch facts`: parses the documents with the built-in Markdown adapter, with no ontology, and reports what it read. */
export async function runFacts(args: string[]): Promise<number> {
  if (wantsHelp(args, ["--config", "--adapter", "--inventory"])) {
    console.log(FACTS_USAGE);
    return 0;
  }
  let opts: ReturnType<typeof parseOptions>["opts"];
  try {
    const parsed = parseOptions(args, ["--config", "--adapter", "--inventory"], ["--json"]);
    expectPositionals(parsed.pos, 0);
    opts = parsed.opts;
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
    console.error(FACTS_USAGE);
    return 2;
  }
  const adapter = resolveMarkdownAdapter({ config: opts.get("--config") as string | undefined, adapter: opts.get("--adapter") as string | undefined });
  const inventory = opts.has("--inventory") ? readInventory(opts.get("--inventory") as string) : null;
  const docs = readDocs(adapter);
  const facts = markdownFacts(docs, adapter.config);

  const lines: string[] = [];
  const factsJson: Record<string, unknown> = {};
  for (const name of NAMES) {
    const d = describeFact(name, facts, adapter.config);
    if (d === null) lines.push(`FACT ${name}: not configured`);
    else {
      lines.push(...d.lines);
      factsJson[name] = d.json;
    }
  }
  const fieldsJson: Record<string, Record<string, { nullable: boolean }>> = {};
  const warnings: string[] = [];
  for (const b of markdownTextBlocks(docs)) {
    const key = `${b.anchor}#${b.first}`;
    lines.push(`FIELDS ${key}: ${b.fields.size} field(s)`);
    for (const s of b.strays) warnings.push(`${b.doc}:${s.line}: ${key}: line is not a field line: ${s.text}`);
    if (Object.hasOwn(fieldsJson, key)) warnings.push(`${b.doc}:${b.line}: ${key}: another text block has the same section anchor and first line; this one is not in the fields`);
    else fieldsJson[key] = byKey(b.fields);
  }
  lines.push(...warnings.map((w) => `WARN ${w}`));
  const diagnostics = facts.diagnostics.map(({ rule, kind, key, msg }) => ({ rule, kind, key, msg }));
  lines.push(...diagnostics.map((d) => `DIAG ${d.rule} ${d.kind} ${d.key}: ${d.msg}`));

  const differences: string[] = [];
  if (inventory !== null) {
    diff("facts", inventory.facts, factsJson, differences);
    diff("fields", inventory.fields, fieldsJson, differences);
  }
  const ok = diagnostics.length === 0 && differences.length === 0;
  if (opts.get("--json") === true) {
    console.log(JSON.stringify({ facts: factsJson, fields: fieldsJson, warnings, diagnostics, ...(inventory !== null ? { differences } : {}) }, null, 2));
  } else {
    for (const l of lines) console.log(l);
    for (const d of differences) console.log(d);
    console.log(diagnostics.length === 0 ? "OK: 0 diagnostic(s)" : `FAIL: ${diagnostics.length} diagnostic(s)`);
  }
  return ok ? 0 : 1;
}
