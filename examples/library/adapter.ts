// Toy library adapter: library.md -> SourceFacts. Fact values are literals; only sections and field lists are parsed. Does not read the ontology.
import { IDENT } from "../../src/checker.js";
import type { Fact, FormatConfig, Invocation, SectionLookup, SourceFacts } from "../../src/contract.js";

// Text generated from the ontology is not a source: drop every BEGIN GENERATED ... END GENERATED block (marker lines included)
// before any fact is extracted. Lines may end in CRLF and markers may be indented. A marker candidate is a line that, trimmed,
// starts with `<!--` and contains the word `GENERATED` (upper case, so `<!-- auto-generated TOC -->` is not one) or starts
// with `<!-- begin generated` / `<!-- end generated` in any case; a candidate that is not a strict marker throws, and markers that do not pair throw.
export function withoutGenerated(doc: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of doc.split(/\r?\n/)) {
    const t = line.trim();
    const begin = /^<!-- BEGIN GENERATED: (\S+) -->$/.exec(t), end = /^<!-- END GENERATED: (\S+) -->$/.exec(t);
    if (!begin && !end && t.startsWith("<!--") && (/\bGENERATED\b/.test(t) || /^<!--\s*(begin|end)\s+generated\b/i.test(t))) throw new Error(`malformed generated-block marker: ${t}`);
    if (begin) {
      if (open !== null) throw new Error(`generated block ${begin[1]} opens inside ${open}`);
      open = begin[1];
    } else if (end) {
      if (open !== end[1]) throw new Error(`generated block end ${end[1]} does not close ${open ?? "an open block"}`);
      open = null;
    } else if (open === null) kept.push(line);
  }
  if (open !== null) throw new Error(`generated block ${open} is not closed`);
  return kept.join("\n");
}

export function buildLibraryFacts(fullDoc: string, evidence: Map<string, Invocation[]>, config: FormatConfig): SourceFacts {
  const doc = withoutGenerated(fullDoc);
  const lines = doc.split("\n");
  const heads = lines.flatMap((l, i) => (/^## \S+ /.test(l) ? [i] : []));
  const sections = new Map<string, { title: string; text: string } | "ambiguous">();
  heads.forEach((h, k) => {
    const title = lines[h].slice(3);
    const anchor = title.split(" ")[0];
    const text = lines.slice(h, heads[k + 1] ?? lines.length).join("\n");
    sections.set(anchor, sections.has(anchor) ? "ambiguous" : { title, text });
  });
  const section = (anchor: string): SectionLookup => sections.get(anchor) ?? "missing";
  const fieldList = (anchor: string, objectType: string): Fact<Map<string, { nullable: boolean }>> | null => {
    const s = sections.get(anchor);
    if (!s || s === "ambiguous") return null;
    const blocks = [...s.text.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.split("\n")[0].trim() === objectType);
    if (blocks.length !== 1) return null;
    return { value: new Map(blocks[0].split("\n").flatMap((l): [string, { nullable: boolean }][] => { const m = /^- (\S+?)(\?)?$/.exec(l); return m ? [[m[1], { nullable: m[2] === "?" }]] : []; })), source: { anchor } };
  };
  const f = <T>(anchor: string, value: T): Fact<T> => ({ value, source: { anchor } });
  return {
    config,
    diagnostics: [],
    info: [],
    section,
    fieldList,
    containsTerm: (t) => IDENT(t).test(doc),
    evidence,
    storeCatalog: f("L8", new Set(["books", "members", "loans", "branches", "people", "audit_log"])),
    stateMachines: new Map([
      ["Book", f("L4", { nodes: ["AVAILABLE", "ON_LOAN", "WITHDRAWN"], initial: ["AVAILABLE"], edges: ["AVAILABLE->ON_LOAN", "ON_LOAN->AVAILABLE", "AVAILABLE->WITHDRAWN"] })],
      ["Loan", f("L5", { nodes: ["ACTIVE", "RETURNED"], initial: ["ACTIVE"], edges: ["ACTIVE->RETURNED"] })],
    ]),
    transitionTriggers: new Map([
      ["Book", new Map([["AVAILABLE->ON_LOAN", f("L6", new Set(["BORROW"]))], ["ON_LOAN->AVAILABLE", f("L6", new Set(["RETURN"]))]])],
      ["Loan", new Map([["ACTIVE->RETURNED", f("L6", new Set(["RETURN"]))]])],
    ]),
    contextMembers: new Map([
      ["Catalog", f("L7", new Set(["Book"]))],
      ["Circulation", f("L7", new Set(["Member", "Loan", "Branch", "Person"]))],
    ]),
    eventCatalog: f("L9", new Set(["loan.created", "loan.returned"])),
    scenarios: { ids: new Set(["S1", "S2"]), cites: new Map([["S1", new Set(["BORROW"])], ["S2", new Set(["RETURN"])]]) },
    permissions: {
      catalog: f("L10", new Set(["loan:create", "loan:close"])),
      rows: f("L10", new Map([["BORROW", { keys: new Set(["loan:create"]), text: "`loan:create`" }], ["RETURN", { keys: new Set(["loan:close"]), text: "`loan:close`" }]])),
      quoteNamesKey: (q, k) => q.includes("`" + k + "`"),
    },
  };
}
