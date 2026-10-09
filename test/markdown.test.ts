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
const toyOnly = (x: Violation) => !["R3", "R7", "R9"].includes(x.rule) && !(x.rule === "R6" && x.kind === "none_but_written");

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
    it(`${name}: same findings as the toy adapter, outside R3, R7, R9 and R6 none_but_written`, () => {
      const g = check(withoutEvidence(o), generic());
      const t = check(withoutEvidence(o), toy());
      expect(rows(g.violations.filter(genericOnly))).toEqual(rows(t.violations.filter(toyOnly)));
      expect(rows(g.waived.filter(genericOnly))).toEqual(rows(t.waived.filter(toyOnly)));
    });

  it("misses exactly the five mutations that need state machines, evidence or scenarios", () => {
    const unseen = cases
      .filter(([, o, expect]) => expect !== null && !check(withoutEvidence(o), generic()).violations.filter(genericOnly).some((x) => x.rule === expect))
      .map(([name]) => name)
      .sort();
    expect(unseen).toEqual(["lib-r3-transition-binding", "lib-r6-none-but-written", "lib-r7-effect-unwitnessed", "lib-r7-undeclared-store", "lib-r9-unknown-scenario"]);
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
  it("default rules: R3, R7 and R9 off with their reasons, every other rule on (R6 included)", () => {
    expect(cfg.profile.rules).toEqual({
      R1: true, R2: true, R3: { disabled: "the Markdown adapter does not parse state machines or transition triggers" }, R4: true, R5: true, R6: true,
      R7: { disabled: "the Markdown adapter reads no execution evidence" }, R8: true, R9: { disabled: "the Markdown adapter does not parse scenarios" }, R10: true, R11: true, R12: true,
    });
    expect(Object.keys(cfg.profile.rules).sort()).toEqual([...RULES].sort());
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
    ['{"docs":["a.md"],"facts":{"scenarios":"L1"}}', "c.json: facts.scenarios: unknown key"],
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
