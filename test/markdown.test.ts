// The built-in Markdown adapter (src/markdown.ts): the toy library through the generic adapter, and the parse conventions.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import fixtureText from "./fixtures/library-markdown.json?raw";
import { check } from "../src/checker";
import { RULES, type Violation } from "../src/contract";
import { markdownFacts, parseMarkdownConfig, type MarkdownFactName } from "../src/markdown";
import { applyPatch } from "../src/patch";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config as toyConfig } from "../examples/library/profile";

const mutations = import.meta.glob("../examples/library/mutations/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const ont = parse(ontologyText);
const cfg = parseMarkdownConfig(fixtureText, "library-markdown.json");
const generic = () => markdownFacts([{ path: cfg.docs[0], text: doc }], cfg);
const toy = () => buildLibraryFacts(doc, libraryEvidence(), toyConfig);
// every actionTypes.*.evidence removed
const withoutEvidence = (o: any) => {
  const c = structuredClone(o);
  for (const a of Object.values(c.actionTypes as Record<string, any>)) delete a.evidence;
  return c;
};
const rows = (xs: Violation[]) => xs.map((x) => [x.rule, x.kind, x.key, x.msg].join("\t")).sort();
const genericOnly = (x: Violation) => !(x.rule === "R6" && x.kind === "fact_missing");
const toyOnly = (x: Violation) => x.rule !== "R7" && !(x.rule === "R6" && x.kind === "none_but_written");

// one inline document through the adapter
const md = (text: string, facts: Partial<Record<MarkdownFactName, string>> = {}) =>
  markdownFacts([{ path: "a.md", text }], parseMarkdownConfig(JSON.stringify({ docs: ["a.md"], facts }), "c.json"));
const sectionText = (f: ReturnType<typeof md>, anchor: string) => {
  const s = f.section(anchor);
  if (typeof s === "string") throw new Error(`${anchor}: ${s}`);
  return s.text;
};
const parseDiags = (f: ReturnType<typeof md>) => f.diagnostics.map((d) => [d.rule, d.kind, d.key]);

describe("toy library through the Markdown adapter", () => {
  const cases: [string, unknown, string | null][] = [
    ["clean", ont, null],
    ...Object.entries(mutations).map(([file, text]): [string, unknown, string] => {
      const m = parse(text);
      return [file.split("/").pop()!.replace(/\.yaml$/, ""), applyPatch(ont, m.patch), m.expect];
    }),
  ];

  it("has the clean ontology and 28 mutations", () => expect(cases.length).toBe(29));

  for (const [name, o] of cases)
    it(`${name}: same findings as the toy adapter, outside R7 and R6 none_but_written`, () => {
      const g = check(withoutEvidence(o), generic());
      const t = check(withoutEvidence(o), toy());
      expect(rows(g.violations.filter(genericOnly))).toEqual(rows(t.violations.filter(toyOnly)));
      expect(rows(g.waived.filter(genericOnly))).toEqual(rows(t.waived.filter(toyOnly)));
    });

  it("misses exactly the three mutations that need evidence", () => {
    const unseen = cases
      .filter(([, o, expect]) => expect !== null && !check(withoutEvidence(o), generic()).violations.filter(genericOnly).some((x) => x.rule === expect))
      .map(([name]) => name)
      .sort();
    expect(unseen).toEqual(["lib-r6-none-but-written", "lib-r7-effect-unwitnessed", "lib-r7-undeclared-store"]);
  });

  it("the clean toy without evidence ids: only R6 fact_missing alone, nothing with the evidence composed in", () => {
    const plain = check(withoutEvidence(ont), generic());
    expect(plain.violations.map((x) => [x.rule, x.kind, x.key])).toEqual([["R6", "fact_missing", "facts.evidence"]]);
    const composed = check(withoutEvidence(ont), { ...generic(), evidence: libraryEvidence() });
    expect(composed.violations).toEqual([]);
    expect(composed.waived).toEqual([]);
  });

  it("fail closed: with no facts configured, each optional fact the enabled rules need is fact_missing", () => {
    const f = markdownFacts([{ path: "library.md", text: doc }], parseMarkdownConfig('{"docs":["library.md"]}', "c.json"));
    for (const k of ["evidence", "stateMachines", "transitionTriggers", "scenarios", "storeCatalog", "contextMembers", "eventCatalog", "permissions"] as const)
      expect(f[k], k).toBeUndefined();
    const missing = check(ont, f).violations.filter((x) => x.kind === "fact_missing").map((x) => [x.rule, x.key]);
    expect(missing).toEqual([["R2", "facts.storeCatalog"], ["R5", "facts.contextMembers"], ["R6", "facts.evidence"], ["R8", "facts.eventCatalog"], ["R10", "facts.permissions"]]);
  });
});

describe("configuration", () => {
  it("default rules: R7 off with its reason, every other rule on (R3, R6 and R9 included, as their facts are set)", () => {
    expect(cfg.profile.rules).toEqual({
      R1: true, R2: true, R3: true, R4: true, R5: true, R6: true,
      R7: { disabled: "the Markdown adapter reads no execution evidence" }, R8: true, R9: true, R10: true, R11: true, R12: true,
    });
    expect(Object.keys(cfg.profile.rules).sort()).toEqual([...RULES].sort());
  });

  it("R9 is off by default without facts.scenarios, on with it, and an explicit switch overrides both", () => {
    const rules = (profile: unknown, facts: unknown) => parseMarkdownConfig(JSON.stringify({ docs: ["a.md"], facts, profile }), "c.json").profile.rules;
    expect(rules({}, {}).R9).toEqual({ disabled: "facts.scenarios is not set: the Markdown adapter reads scenarios only from that section" });
    expect(rules({}, { scenarios: "L11" }).R9).toBe(true);
    expect(rules({ rules: { R9: { disabled: "x" } } }, { scenarios: "L11" }).R9).toEqual({ disabled: "x" });
    expect(rules({ rules: { R9: true } }, {}).R9).toBe(true);
  });

  it("profile defaults and requiredSource", () => {
    expect(cfg.profile.requiredSource).toEqual({ R10: "L10" });
    expect(cfg.profile.crossContextMechanisms).toEqual(["same_transaction"]);
    const bare = parseMarkdownConfig('{"docs":["a.md"]}', "c.json").profile;
    expect(bare.requiredSource).toEqual({});
    expect(bare.actionIdPattern).toEqual(/^[A-Z][A-Z_]*$/);
    expect(bare.linkFieldPattern).toEqual(/_id$/);
    expect(bare.stateProperty).toBe("state");
    expect(bare.crossContextMechanisms).toEqual([]);
    for (const k of ["scenarioCoverage", "idempotencyDeclarationRequired", "evidenceRequired"]) expect(k in bare, k).toBe(false);
  });

  it("a configured rule switch overrides the default", () => {
    const p = parseMarkdownConfig('{"docs":["a.md"],"profile":{"rules":{"R6":{"disabled":"no links"},"R9":true},"evidenceRequired":true}}', "c.json").profile;
    expect(p.rules.R6).toEqual({ disabled: "no links" });
    expect(p.rules.R9).toBe(true);
    expect(p.evidenceRequired).toBe(true);
  });

  it.each([
    ['{"docs":["a.md"],"extra":1}', "c.json: extra: unknown key"],
    ['{"facts":{}}', "c.json: docs: missing"],
    ['{"docs":[]}', "c.json: docs: must be a non-empty array of strings"],
    ['{"docs":["a.md","a.md"]}', "c.json: docs[1]: duplicate of docs[0]"],
    ['{"docs":["a.md"],"facts":{"stateMachines":"L1"}}', "c.json: facts.stateMachines: must be a non-empty object of anchors"],
    ['{"docs":["a.md"],"facts":{"stateMachines":{}}}', "c.json: facts.stateMachines: must be a non-empty object of anchors"],
    ['{"docs":["a.md"],"facts":{"stateMachines":{"Book":""},"transitionTriggers":"L6"}}', "c.json: facts.stateMachines.Book: must be a non-empty string"],
    ['{"docs":["a.md"],"facts":{"transitionTriggers":""}}', "c.json: facts.transitionTriggers: must be a non-empty string"],
    ['{"docs":["a.md"],"facts":{"stateMachines":{"Book":"L4"}}}', "c.json: facts.stateMachines: requires facts.transitionTriggers"],
    ['{"docs":["a.md"],"facts":{"transitionTriggers":"L6"}}', "c.json: facts.transitionTriggers: requires facts.stateMachines"],
    ['{"docs":["a.md"],"profile":{"actionIdPattern":"("}}', "c.json: profile.actionIdPattern: invalid regular expression"],
    ['{"docs":["a.md"],"profile":{"rules":{"R13":true}}}', "c.json: profile.rules.R13: unknown rule"],
    ['{"docs":["a.md"],"profile":{"rules":{"R6":false}}}', "c.json: profile.rules.R6: must be true"],
    ['{"docs":["a.md"],"profile":{"color":"red"}}', "c.json: profile.color: unknown key"],
    ["not json", "c.json: (root): not valid JSON"],
    ['{"docs":["a.md"],"facts":{"toString":"X"}}', "c.json: facts.toString: unknown key"],
    ['{"docs":["a.md"],"facts":{"__proto__":"X"}}', "c.json: facts.__proto__: unknown key"],
    ['{"docs":["a.md"],"profile":{"__proto__":{"rules":{}}}}', "c.json: profile.__proto__: unknown key"],
    ['{"docs":["a.md"],"profile":{"rules":{"constructor":true}}}', "c.json: profile.rules.constructor: unknown rule"],
  ])("rejects %s", (text, msg) => expect(() => parseMarkdownConfig(text, "c.json")).toThrow(msg));
});

describe("sections", () => {
  it("short anchor: the first word without one trailing dot", () => {
    const f = md("## 3.2. Pricing\nbody\n## L1 Book\n");
    expect(f.section("3.2")).toEqual({ title: "3.2. Pricing", text: "## 3.2. Pricing\nbody" });
    expect(typeof f.section("L1")).toBe("object");
  });

  it("full-title anchor, closing hashes dropped; a repeated title is ambiguous", () => {
    const f = md("## Open a rental\nx\n## Overview\na\n## Close it ##\n## Overview\nb\n");
    expect(sectionText(f, "Open a rental")).toBe("## Open a rental\nx");
    expect(typeof f.section("Open")).toBe("object");
    expect(typeof f.section("Close it")).toBe("object");
    expect(f.section("Overview")).toBe("ambiguous");
    expect(f.section("Nothing")).toBe("missing");
  });

  it("a leading section sign falls back to the anchor without it, only when the anchor as written has no heading", () => {
    const f = md("## 6.4 A\nbody");
    expect(f.section("§6.4")).toEqual({ title: "6.4 A", text: "## 6.4 A\nbody" });
    expect(f.section("6.4")).toEqual({ title: "6.4 A", text: "## 6.4 A\nbody" });
    expect(f.section("§9.9")).toBe("missing");
    const both = md("## §6.4 A\nx\n## 6.4 B\ny");
    expect(both.section("§6.4")).toEqual({ title: "§6.4 A", text: "## §6.4 A\nx" });
    expect(both.section("6.4")).toEqual({ title: "6.4 B", text: "## 6.4 B\ny" });
  });

  it("a section ends before the next heading of the same or a higher level", () => {
    const f = md("## A one\n### B two\nbody\n## C three\n");
    expect(sectionText(f, "A")).toBe("## A one\n### B two\nbody");
    expect(sectionText(f, "B")).toBe("### B two\nbody");
  });

  it("a heading inside a fence is not a heading", () => {
    const f = md("## A one\n```\n## B two\n```\nafter\n");
    expect(f.section("B")).toBe("missing");
    expect(sectionText(f, "A")).toContain("after");
  });

  it("a four-backtick fence is not closed by a three-backtick line", () => {
    const f = md("## A one\n````\n```\n## Not a heading\n```\n````\n## After it\n");
    expect(f.section("Not")).toBe("missing");
    expect(typeof f.section("After")).toBe("object");
    expect(f.diagnostics).toEqual([]);
  });

  it("a fence indented up to three spaces counts the same for headings and generated blocks; four spaces is no fence", () => {
    const f = md("## A one\n   ```\n<!-- BEGIN GENERATED: g -->\n## Inside x\n   ```\n## Out y\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.section("Inside")).toBe("missing");
    expect(f.containsTerm("Inside")).toBe(true);
    expect(typeof f.section("Out")).toBe("object");
    expect(typeof md("    ```\n## H x\n").section("H")).toBe("object");
  });

  it("an anchor in two documents is ambiguous", () => {
    const c = parseMarkdownConfig('{"docs":["a.md","b.md"]}', "c.json");
    const f = markdownFacts([{ path: "a.md", text: "## L1 A\n" }, { path: "b.md", text: "## L1 B\n## L2 C\n" }], c);
    expect(f.section("L1")).toBe("ambiguous");
    expect(typeof f.section("L2")).toBe("object");
  });

  it("CRLF line ends and a leading BOM", () => {
    const f = md("﻿## A one\r\nline\r\n## B two\r\n");
    expect(sectionText(f, "A")).toBe("## A one\nline");
    expect(typeof f.section("B")).toBe("object");
  });

  it("an unclosed fence is a markdown_fence diagnostic", () => {
    expect(parseDiags(md("## A x\n```\nopen\n"))).toEqual([["R2", "markdown_fence", "doc:a.md"]]);
  });
});

describe("generated blocks", () => {
  it("an annotated block is removed with its markers; containsTerm does not see it", () => {
    const f = md("## A x\n<!-- BEGIN GENERATED: g.1 (from the model) -->\nHIDDEN_WORD\n<!-- END GENERATED: g.1 -->\nSHOWN_WORD\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.containsTerm("HIDDEN_WORD")).toBe(false);
    expect(f.containsTerm("SHOWN_WORD")).toBe(true);
    expect(sectionText(f, "A")).toBe("## A x\nSHOWN_WORD\n");
  });

  it("a comment that only contains the word GENERATED is not a marker", () => {
    const f = md("## A x\n<!-- GENERATED by a site tool -->\nWORD\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.containsTerm("site")).toBe(true);
  });

  it.each([
    ["malformed", "<!-- BEGIN GENERATED g -->\nHIDDEN_WORD\n<!-- END GENERATED: g -->"],
    ["nested", "<!-- BEGIN GENERATED: g -->\n<!-- BEGIN GENERATED: h -->\nHIDDEN_WORD\n<!-- END GENERATED: h -->\n<!-- END GENERATED: g -->"],
    ["mismatched end", "<!-- BEGIN GENERATED: g -->\nHIDDEN_WORD\n<!-- END GENERATED: h -->"],
    ["unclosed", "<!-- BEGIN GENERATED: g -->\nHIDDEN_WORD"],
  ])("%s markers: a markdown_generated_blocks diagnostic, and the raw text is used", (_, block) => {
    const f = md(`## A x\n${block}\n`);
    expect(parseDiags(f)).toEqual([["R2", "markdown_generated_blocks", "doc:a.md"]]);
    expect(f.containsTerm("HIDDEN_WORD")).toBe(true);
  });
});

describe("field lists", () => {
  it("split on ' / ', drop // comments, merge ? of a repeated field, null when not exactly one list", () => {
    const f = md("## L1 Book\n```text\nBook\n- a / b?\n- c // the c field\n- a?\n```\n```text\nOther\n- x\n```\n```text\nOther\n- y\n```\n");
    expect(f.fieldList("L1", "Book")).toEqual({
      value: new Map([["a", { nullable: true }], ["b", { nullable: true }], ["c", { nullable: false }]]),
      source: { anchor: "L1" },
    });
    expect(f.fieldList("L1", "Other")).toBeNull();
    expect(f.fieldList("L1", "None")).toBeNull();
    expect(f.fieldList("L9", "Book")).toBeNull();
  });
});

describe("text blocks", () => {
  it("a text block inside another fence is body text: no field list, no catalog", () => {
    const text = "## L1 Book\n````md\n```text\nBook\n- fake\n```\n````\n";
    expect(md(text).fieldList("L1", "Book")).toBeNull();
    const f = md(text, { storeCatalog: "L1" });
    expect(f.storeCatalog!.value).toEqual(new Set());
    expect(parseDiags(f)).toEqual([["R2", "markdown_parse", "facts.storeCatalog"]]);
  });
});

describe("configured facts", () => {
  it("a missing or ambiguous anchor is a markdown_anchor diagnostic and an empty value", () => {
    const f = md("## L1 A\n## L2 B\n## L2 C\n", { storeCatalog: "L8", contextMembers: "L2", permissions: "L8" });
    expect(f.diagnostics).toEqual([
      { rule: "R2", kind: "markdown_anchor", key: "facts.storeCatalog", msg: "anchor L8 of facts.storeCatalog is missing" },
      { rule: "R5", kind: "markdown_anchor", key: "facts.contextMembers", msg: "anchor L2 of facts.contextMembers is ambiguous" },
      { rule: "R10", kind: "markdown_anchor", key: "facts.permissions", msg: "anchor L8 of facts.permissions is missing" },
    ]);
    expect(f.storeCatalog).toEqual({ value: new Set(), source: { anchor: "L8" } });
    expect(f.contextMembers).toEqual(new Map());
    expect(f.permissions!.catalog.value).toEqual(new Set());
    expect(f.permissions!.rows.value).toEqual(new Map());
    expect(f.eventCatalog).toBeUndefined();
  });

  it("catalog: comments dropped, empty lines skipped, a line with white space is markdown_parse", () => {
    const f = md("## S Stores\n```text\nbooks // the books\n\nloans\nbad line\n```\n", { storeCatalog: "S", eventCatalog: "S" });
    expect(f.storeCatalog!.value).toEqual(new Set(["books", "loans"]));
    expect(parseDiags(f)).toEqual([["R2", "markdown_parse", "facts.storeCatalog"], ["R8", "markdown_parse", "facts.eventCatalog"]]);
  });

  it("catalog: ' / ' separates names; a slash without white space is part of a name; any other white space is markdown_parse", () => {
    const c = (line: string) => md(`## S Stores\n\`\`\`text\n${line}\n\`\`\`\n`, { storeCatalog: "S" });
    expect(c("a / b").storeCatalog!.value).toEqual(new Set(["a", "b"]));
    expect(c("a/b // note").storeCatalog!.value).toEqual(new Set(["a/b"]));
    expect(c("a  /  b").storeCatalog!.value).toEqual(new Set(["a", "b"]));
    expect(c("a / b").diagnostics).toEqual([]);
    for (const bad of ["a / b / ", "a /  / b", "a b"]) expect(parseDiags(c(bad))).toEqual([["R2", "markdown_parse", "facts.storeCatalog"]]);
  });

  it("a configured anchor with a section sign resolves; the fact keeps the anchor as configured", () => {
    const f = md("## 6.4 Stores\n```text\nbooks\n```\n", { storeCatalog: "§6.4" });
    expect(f.diagnostics).toEqual([]);
    expect(f.storeCatalog).toEqual({ value: new Set(["books"]), source: { anchor: "§6.4" } });
  });

  it("catalog: not exactly one text block is markdown_parse", () => {
    const f = md("## S Stores\nno block\n", { storeCatalog: "S" });
    expect(f.storeCatalog!.value).toEqual(new Set());
    expect(parseDiags(f)).toEqual([["R2", "markdown_parse", "facts.storeCatalog"]]);
  });

  it("context members: lines outside fences, members split on commas", () => {
    const f = md("## C Contexts\n- Catalog: Book\n- Circulation: Member, Loan,\n```\n- Hidden: X\n```\n", { contextMembers: "C" });
    expect(f.diagnostics).toEqual([]);
    expect(f.contextMembers).toEqual(new Map([
      ["Catalog", { value: new Set(["Book"]), source: { anchor: "C" } }],
      ["Circulation", { value: new Set(["Member", "Loan"]), source: { anchor: "C" } }],
    ]));
  });

  it("context members: no entry, or a context listed twice, is markdown_parse", () => {
    expect(parseDiags(md("## C Contexts\nnothing\n", { contextMembers: "C" }))).toEqual([["R5", "markdown_parse", "facts.contextMembers"]]);
    const twice = md("## C Contexts\n- A: X\n- A: Y\n", { contextMembers: "C" });
    expect(parseDiags(twice)).toEqual([["R5", "markdown_parse", "facts.contextMembers"]]);
    expect(twice.contextMembers!.get("A")!.value).toEqual(new Set(["X"]));
  });

  const scen = (body: string, profile = {}) =>
    markdownFacts([{ path: "a.md", text: `## L11 Scenarios\n\n${body}\n` }], parseMarkdownConfig(JSON.stringify({ docs: ["a.md"], facts: { scenarios: "L11" }, profile }), "c.json"));

  it("scenarios: a scenario cites the actions in its closing bracket, not other upper-case words", () => {
    const f = scen("- S1: an AVAILABLE book (BORROW).");
    expect(f.diagnostics).toEqual([]);
    expect(f.scenarios).toEqual({ ids: new Set(["S1"]), cites: new Map([["S1", new Set(["BORROW"])]]) });
  });

  it("scenarios: full-width brackets, full-width comma and ideographic full stop", () => {
    const f = scen("- S2: x （RETURN，BORROW）。");
    expect(f.diagnostics).toEqual([]);
    expect(f.scenarios!.cites.get("S2")).toEqual(new Set(["RETURN", "BORROW"]));
  });

  it("scenarios: white space before the full stop is allowed; brackets of two kinds are not a pair", () => {
    expect(scen("- S1: x (BORROW) .").scenarios!.cites.get("S1")).toEqual(new Set(["BORROW"]));
    expect(scen("- S1: x (BORROW）。").scenarios!.cites.get("S1")).toEqual(new Set());
  });

  it("scenarios: the id is one word; a line whose text before ': ' has white space is not a scenario", () => {
    const f = scen("- S1: x (BORROW).\n- Happy path: y (RETURN).");
    expect([...f.scenarios!.ids]).toEqual(["S1"]);
  });

  it("scenarios: a line with no closing bracket cites nothing", () => {
    const f = scen("- S3: no actions");
    expect(f.diagnostics).toEqual([]);
    expect(f.scenarios).toEqual({ ids: new Set(["S3"]), cites: new Map([["S3", new Set()]]) });
  });

  it("scenarios: a cited item that does not match actionIdPattern is markdown_parse and is not cited", () => {
    const f = scen("- S1: x (BORROW, lower)");
    expect(parseDiags(f)).toEqual([["R9", "markdown_parse", "facts.scenarios"]]);
    expect(f.scenarios!.cites.get("S1")).toEqual(new Set(["BORROW"]));
  });

  it("scenarios: a repeated id is markdown_parse and the first is kept", () => {
    const f = scen("- S1: x (BORROW)\n- S1: y (RETURN)");
    expect(parseDiags(f)).toEqual([["R9", "markdown_parse", "facts.scenarios"]]);
    expect(f.scenarios).toEqual({ ids: new Set(["S1"]), cites: new Map([["S1", new Set(["BORROW"])]]) });
  });

  it("scenarios: a section with no scenario line is markdown_parse; a line inside a fence is not a scenario", () => {
    const f = scen("nothing\n```\n- S1: x (BORROW)\n```");
    expect(parseDiags(f)).toEqual([["R9", "markdown_parse", "facts.scenarios"]]);
    expect(f.scenarios).toEqual({ ids: new Set(), cites: new Map() });
  });

  it("scenarios: a missing anchor is markdown_anchor and an empty fact", () => {
    const f = md("## L1 A\n", { scenarios: "L11" });
    expect(parseDiags(f)).toEqual([["R9", "markdown_anchor", "facts.scenarios"]]);
    expect(f.scenarios).toEqual({ ids: new Set(), cites: new Map() });
  });

  const diag = (f: ReturnType<typeof md>) => f.diagnostics.map((d) => [d.rule, d.kind, d.key]);
  const machines = (text: string, object = "Book") =>
    markdownFacts([{ path: "a.md", text }], { ...parseMarkdownConfig('{"docs":["a.md"]}', "c.json"), stateMachines: { [object]: "L4" } });
  const bind = (table: string) =>
    markdownFacts([{ path: "a.md", text: `## L6 Actions\n\n${table}\n` }], { ...parseMarkdownConfig('{"docs":["a.md"]}', "c.json"), facts: { transitionTriggers: "L6" } });
  const triggers = (table: string) => {
    const f = bind(`| Object | Transition | Trigger |\n|---|---|---|\n${table}`);
    return { f, map: f.transitionTriggers! };
  };

  it("state machine: the spaces around --> and before : are optional", () => {
    const f = machines("## L4 Book State\n\n```mermaid\nstateDiagram-v2\n[*]-->A\nA --> B: go\n```\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.stateMachines!.get("Book")!.value).toEqual({ nodes: ["A", "B"], initial: ["A"], edges: ["A->B"] });
  });

  it("state machine: a labelled initial edge parses; one-line and block notes are ignored", () => {
    const f = machines("## L4 Book State\n\n```plantuml\n@startuml\ntitle Book\n[*] --> A : START\nnote left of A : x\nA --> B\nnote right of A\n  A --> Z\n  free text\nend note\nB --> [*]\n@enduml\n```\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.stateMachines!.get("Book")).toEqual({ value: { nodes: ["A", "B"], initial: ["A"], edges: ["A->B"] }, source: { anchor: "L4" } });
  });

  it("state machine: a repeated edge is kept once; a transition into [*] adds a node and no edge", () => {
    const f = machines("## L4 Book State\n```plantuml\n[*] --> A\nA --> B : x\nA --> B : y\nB --> [*]\nC --> [*]\n```\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.stateMachines!.get("Book")!.value).toEqual({ nodes: ["A", "B", "C"], initial: ["A"], edges: ["A->B"] });
  });

  it("state machine: mermaid whose first line is a %% comment, then stateDiagram-v2", () => {
    const f = machines("## L4 Book State\n```mermaid\n%% lifecycle\n\nstateDiagram-v2\ndirection LR\n[*] --> A\nA --> B\n```\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.stateMachines!.get("Book")!.value).toEqual({ nodes: ["A", "B"], initial: ["A"], edges: ["A->B"] });
  });

  it("state machine: a mermaid block that is not a state diagram is not a state block", () => {
    const f = machines("## L4 Book State\n```mermaid\nflowchart LR\nA --> B\n```\n```plantuml\n[*] --> A\n```\n");
    expect(f.diagnostics).toEqual([]);
    expect(f.stateMachines!.get("Book")!.value).toEqual({ nodes: ["A"], initial: ["A"], edges: [] });
  });

  it.each([
    ["an arrow of one dash pair", "A -> B"],
    ["a composite state", "state X {"],
    ["a quoted state", 'state "x" as X'],
    ["a stereotype", "state C <<choice>>"],
    ["an edge from the initial state to itself", "[*] --> [*]"],
    ["a name that is not an identifier", "A --> B-1"],
    ["a note block that is not closed", "note left of A"],
  ])("state machine: %s is markdown_parse and the value is null", (_, line) => {
    const f = machines(`## L4 Book State\n\`\`\`plantuml\n[*] --> A\n${line}\n\`\`\`\n`);
    expect(diag(f)).toEqual([["R3", "markdown_parse", "facts.stateMachines.Book"]]);
    expect(f.stateMachines!.get("Book")).toEqual({ value: null, source: { anchor: "L4" } });
  });

  it("state machine: two state blocks in one section are markdown_parse and the value is null; none too", () => {
    const one = "```plantuml\n[*] --> A\n```\n";
    const two = machines(`## L4 Book State\n${one}${one}`);
    expect(diag(two)).toEqual([["R3", "markdown_parse", "facts.stateMachines.Book"]]);
    expect(two.stateMachines!.get("Book")!.value).toBeNull();
    expect(diag(machines("## L4 Book State\n```text\n[*] --> A\n```\n"))).toEqual([["R3", "markdown_parse", "facts.stateMachines.Book"]]);
  });

  it("state machine: a missing or ambiguous anchor is markdown_anchor with the key of the object; one fact for each configured object", () => {
    const f = markdownFacts([{ path: "a.md", text: "## L4 A\n```plantuml\n[*] --> A\n```\n## L5 B\n## L5 C\n" }], {
      ...parseMarkdownConfig('{"docs":["a.md"]}', "c.json"),
      stateMachines: { Book: "L4", Loan: "L5", Member: "L9" },
    });
    expect(f.diagnostics).toEqual([
      { rule: "R3", kind: "markdown_anchor", key: "facts.stateMachines.Loan", msg: "anchor L5 of facts.stateMachines.Loan is ambiguous" },
      { rule: "R3", kind: "markdown_anchor", key: "facts.stateMachines.Member", msg: "anchor L9 of facts.stateMachines.Member is missing" },
    ]);
    expect([...f.stateMachines!.keys()]).toEqual(["Book", "Loan", "Member"]);
    expect(f.stateMachines!.get("Loan")).toEqual({ value: null, source: { anchor: "L5" } });
    expect(f.stateMachines!.get("Book")!.value).not.toBeNull();
  });

  it("transition triggers: a missing anchor is markdown_anchor and an empty map", () => {
    const f = markdownFacts([{ path: "a.md", text: "## L1 A\n" }], { ...parseMarkdownConfig('{"docs":["a.md"]}', "c.json"), facts: { transitionTriggers: "L6" } });
    expect(f.diagnostics).toEqual([{ rule: "R3", kind: "markdown_anchor", key: "facts.transitionTriggers", msg: "anchor L6 of facts.transitionTriggers is missing" }]);
    expect(f.transitionTriggers).toEqual(new Map());
  });

  it("transition triggers: the toy table", () => {
    const f = generic();
    expect(f.diagnostics).toEqual([]);
    expect(f.transitionTriggers).toEqual(new Map([
      ["Book", new Map([["AVAILABLE->ON_LOAN", { value: new Set(["BORROW"]), source: { anchor: "L6" } }], ["ON_LOAN->AVAILABLE", { value: new Set(["RETURN"]), source: { anchor: "L6" } }]])],
      ["Loan", new Map([["ACTIVE->RETURNED", { value: new Set(["RETURN"]), source: { anchor: "L6" } }]])],
    ]));
  });

  it("transition triggers: a cell that is not a list of action ids is markdown_parse and the row binds nothing", () => {
    const { f, map } = triggers("| Task | PENDING → STARTED | START_RUN；或任一 Fact（COMPLETE_TASK） |\n| Task | STARTED → DONE | COMPLETE_TASK |");
    expect(parseDiags(f)).toEqual([["R3", "markdown_parse", "facts.transitionTriggers"]]);
    expect(map.get("Task")!.has("PENDING->STARTED")).toBe(false);
    expect(map.get("Task")!.get("STARTED->DONE")!.value).toEqual(new Set(["COMPLETE_TASK"]));
  });

  it("transition triggers: ' / ' lists states on either side, a comma lists transitions, the same edge in two rows is a union", () => {
    const { f, map } = triggers("| Task | PENDING / ACCEPTED → STARTED | START_RUN |\n| Task | PENDING -> STARTED，STARTED → DONE | PAUSE, START_RUN |\n| Task | DONE → A / B | X |");
    expect(f.diagnostics).toEqual([]);
    const t = map.get("Task")!;
    expect([...t.keys()]).toEqual(["PENDING->STARTED", "ACCEPTED->STARTED", "STARTED->DONE", "DONE->A", "DONE->B"]);
    expect(t.get("PENDING->STARTED")!.value).toEqual(new Set(["START_RUN", "PAUSE"]));
    expect(t.get("ACCEPTED->STARTED")!.value).toEqual(new Set(["START_RUN"]));
    expect(t.get("STARTED->DONE")!.value).toEqual(new Set(["START_RUN", "PAUSE"]));
  });

  it.each([
    ["a transition that is not 'S → S'", "| Task | PENDING STARTED | START_RUN |"],
    ["a state that is not an identifier", "| Task | PENDING → STARTED-1 | START_RUN |"],
    ["an empty part of the transition list", "| Task | PENDING → STARTED, | START_RUN |"],
    ["an empty trigger cell", "| Task | PENDING → STARTED | |"],
    ["a trigger that does not match actionIdPattern", "| Task | PENDING → STARTED | start_run |"],
    ["a row of two columns", "| Task | PENDING → STARTED |"],
  ])("transition triggers: %s is markdown_parse and the row binds nothing", (_, row) => {
    const { f, map } = triggers(row);
    expect(parseDiags(f)).toEqual([["R3", "markdown_parse", "facts.transitionTriggers"]]);
    expect(map).toEqual(new Map());
  });

  it.each([
    ["no table", ""],
    ["two tables", "| A | B | C |\n|---|---|---|\n| x | A → B | Y |\n\ntext\n\n| A | B | C |\n|---|---|---|\n| x | A → B | Y |"],
    ["a two-column header", "| A | B |\n|---|---|\n| x | y |"],
  ])("transition triggers: %s is markdown_parse and an empty map", (_, table) => {
    const f = bind(table);
    expect(parseDiags(f)).toEqual([["R3", "markdown_parse", "facts.transitionTriggers"]]);
    expect(f.transitionTriggers).toEqual(new Map());
  });

  it("a line outside the grammar in L4 of the clean toy fails the check", () => {
    const f = markdownFacts([{ path: cfg.docs[0], text: doc.replace("AVAILABLE --> WITHDRAWN\n", "AVAILABLE --> WITHDRAWN\nA -> B\n") }], cfg);
    expect(f.stateMachines!.get("Book")!.value).toBeNull();
    const r = check(withoutEvidence(ont), f).violations.filter((x) => x.rule === "R3");
    expect(r.map((x) => [x.kind, x.key])).toEqual([["markdown_parse", "facts.stateMachines.Book"]]);
  });

  it("a trigger row for an action that the ontology does not declare: R3 transition_binding_missing (the adapter does not filter by the ontology)", () => {
    const row = "| Loan | ACTIVE → RETURNED | RETURN |\n";
    expect(doc).toContain(row);
    const f = markdownFacts([{ path: cfg.docs[0], text: doc.replace(row, `${row}| Book | AVAILABLE → WITHDRAWN | WITHDRAW |\n`) }], cfg);
    expect(f.diagnostics).toEqual([]);
    const r = check(withoutEvidence(ont), f).violations.filter((x) => x.rule === "R3");
    expect(r.map((x) => [x.kind, x.key])).toEqual([["transition_binding_missing", "Book:AVAILABLE->WITHDRAWN:WITHDRAW"]]);
  });

  it("state machines and transition triggers are set together or not at all", () => {
    const cfgOf = (facts: unknown) => () => parseMarkdownConfig(JSON.stringify({ docs: ["a.md"], facts }), "c.json");
    expect(cfgOf({ stateMachines: { Book: "L4" } })).toThrow("c.json: facts.stateMachines: requires facts.transitionTriggers");
    expect(cfgOf({ transitionTriggers: "L6" })).toThrow("c.json: facts.transitionTriggers: requires facts.stateMachines");
    expect(cfgOf({ stateMachines: { Book: "L4" }, transitionTriggers: "L6" })().stateMachines).toEqual({ Book: "L4" });
  });

  it("R3 is on by default when both are set, off with the reason when neither is, and an explicit switch overrides", () => {
    const rules = (profile: unknown, facts: unknown) => parseMarkdownConfig(JSON.stringify({ docs: ["a.md"], facts, profile }), "c.json").profile.rules;
    const both = { stateMachines: { Book: "L4" }, transitionTriggers: "L6" };
    expect(rules({}, both).R3).toBe(true);
    expect(rules({}, {}).R3).toEqual({ disabled: "facts.stateMachines and facts.transitionTriggers are not set: the Markdown adapter reads state machines only from those sections" });
    expect(rules({ rules: { R3: { disabled: "x" } } }, both).R3).toEqual({ disabled: "x" });
    expect(rules({ rules: { R3: true } }, {}).R3).toBe(true);
  });

  const perm = (table: string) => md(`## P Permissions\n\`\`\`text\nloan:create\nloan:close\n\`\`\`\n\n${table}\n`, { permissions: "P" });

  it("permissions: rows of the one two-column table; escaped and code-span pipes do not split; alignment row without trailing pipe", () => {
    const f = perm("| Action | Keys |\n|---|:--\n| BORROW, LEND | `loan:create` |\n| RETURN | `a|b` or x\\|y `loan:close`");
    expect(f.diagnostics).toEqual([]);
    expect(f.permissions!.catalog).toEqual({ value: new Set(["loan:create", "loan:close"]), source: { anchor: "P" } });
    expect(f.permissions!.rows).toEqual({
      value: new Map([
        ["BORROW", { keys: new Set(["loan:create"]), text: "`loan:create`" }],
        ["LEND", { keys: new Set(["loan:create"]), text: "`loan:create`" }],
        ["RETURN", { keys: new Set(["a|b", "loan:close"]), text: "`a|b` or x|y `loan:close`" }],
      ]),
      source: { anchor: "P" },
    });
    expect(f.permissions!.quoteNamesKey("needs `loan:create`", "loan:create")).toBe(true);
    expect(f.permissions!.quoteNamesKey("needs loan:create", "loan:create")).toBe(false);
    expect(f.config.requiredSource).toEqual({ R10: "P" });
  });

  it("permissions: row names split on a comma and on the ideographic comma", () => {
    const f = perm("| Action | Keys |\n|---|---|\n| BORROW、RETURN | `loan:create` |");
    expect(f.diagnostics).toEqual([]);
    expect([...f.permissions!.rows.value.keys()]).toEqual(["BORROW", "RETURN"]);
  });

  it.each([
    ["no table", ""],
    ["two tables", "| A | K |\n|---|---|\n| X | `k` |\n\n| A | K |\n|---|---|\n| Y | `k` |"],
    ["a three-column header", "| A | K | Z |\n|---|---|---|\n| X | `k` | z |"],
  ])("permissions: %s is markdown_parse and no rows", (_, table) => {
    const f = perm(table);
    expect(parseDiags(f)).toEqual([["R10", "markdown_parse", "facts.permissions"]]);
    expect(f.permissions!.rows.value).toEqual(new Map());
  });

  it.each([
    ["a fence", "```md\nx\n```"],
    ["a generated block", "<!-- BEGIN GENERATED: g -->\nx\n<!-- END GENERATED: g -->"],
  ])("permissions: %s between two runs of rows ends the table", (_, between) => {
    const f = perm(`| Action | Keys |\n|---|---|\n| A | \`k\` |\n${between}\n| Other | Table |\n| B | \`z\` |`);
    expect(f.diagnostics.map((d) => [d.rule, d.kind, d.key, d.msg])).toEqual([["R10", "markdown_parse", "facts.permissions", "facts.permissions needs exactly one pipe table in its section, found 2"]]);
    expect(f.permissions!.rows.value).toEqual(new Map());
  });

  it("permissions: an escaped backtick opens no code span; keys come from the same span scanner", () => {
    const f = perm("| Action | Keys |\n|---|---|\n| A | a \\` tick, then `k` |\n| B | ``a`|`b`` |\n| C | a \\` x | `k` |");
    expect(parseDiags(f)).toEqual([["R10", "markdown_parse", "facts.permissions"]]); // row C has three cells
    expect(f.permissions!.rows.value.get("A")).toEqual({ keys: new Set(["k"]), text: "a \\` tick, then `k`" });
    expect(f.permissions!.rows.value.get("B")).toEqual({ keys: new Set(["a`|`b"]), text: "``a`|`b``" });
    expect(f.permissions!.rows.value.has("C")).toBe(false);
  });

  it("permissions: a three-column row is skipped, a repeated row name keeps the first row", () => {
    const f = perm("| A | K |\n|---|---|\n| X | `k1` |\n| Y | `k` | extra |\n| X | `k2` |");
    expect(parseDiags(f)).toEqual([["R10", "markdown_parse", "facts.permissions"], ["R10", "markdown_parse", "facts.permissions"]]);
    expect([...f.permissions!.rows.value.keys()]).toEqual(["X"]);
    expect(f.permissions!.rows.value.get("X")!.keys).toEqual(new Set(["k1"]));
  });
});
