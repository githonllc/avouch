// avouch gate docs: the document review ledger. Units, outline, pointers, ledger shape, configuration and the command line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { compareEntries, docUnits, outlineHash, parseLedger, resolvePointer, verifyLedger, type LedgerDoc, type LedgerEntry, type LedgerResult } from "../src/index";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli/avouch.js");
const libraryText = readFileSync(join(root, "examples/library/library.md"), "utf8");
const libraryOntologyText = readFileSync(join(root, "examples/library/library.ontology.yaml"), "utf8");
const library = parse(libraryOntologyText) as Record<string, any>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const TOP = "Library: toy project for the ontology spec";
const DOC = "library.md";
const directories: string[] = [];
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const gitAvailable = git(root, "--version").status === 0;

afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
const directory = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "avouch-ledger-")));
  directories.push(d);
  return d;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

// The claims of the toy ledger: two units name ontology places, the other units have a reason.
const CLAIMS: Record<string, string[]> = { "L3 Loan": ["/linkTypes/loan_book", "/objectTypes/Loan"], "L4 Book State": ["/stateMachines/Book"] };
// The ledger values (header, outline and unit entries, in ledger order) for the current units of the documents.
function ledgerValues(docs: LedgerDoc[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const d of docs) {
    const units = docUnits(d, sha256);
    out.push({ doc: d.doc, outline: outlineHash(units, sha256) });
    for (const u of units.filter((x) => !x.empty)) {
      const claims = CLAIMS[u.path.at(-1) ?? ""];
      out.push({ doc: u.doc, path: u.path, n: u.n, sha256: u.sha256, ...(claims ? { claims } : { noClaim: "no domain rule" }) });
    }
  }
  out.sort((a, b) => compareEntries(a as never, b as never));
  return [{ avouchLedger: 1 }, ...out];
}
const asLines = (values: unknown[]) => values.map((value, i) => ({ line: i + 1, value }));
const entriesOf = (docs: LedgerDoc[]): LedgerEntry[] => parseLedger(asLines(ledgerValues(docs)));
const jsonl = (values: unknown[]) => values.map((v) => JSON.stringify(v)).join("\n") + "\n";
// The failures of a result, as `<kind> <last title or doc>` lines (empty: the gate passes).
const failures = (r: LedgerResult): string[] => [
  ...r.changed.map((u) => `changed ${u.path.at(-1)}`),
  ...r.unreviewed.map((u) => `unreviewed ${u.path.at(-1)}`),
  ...r.stale.map((s) => ("outline" in s ? `stale ${s.doc} outline` : `stale ${s.path.at(-1)}`)),
  ...r.outline.map((o) => `outline ${o.doc}`),
  ...r.dangling.map((d) => `dangling ${d.path.at(-1)} ${d.pointer}`),
];
const units = (text: string) => docUnits({ doc: "d.md", text }, sha256);
// The text of one section of the toy (from its heading to the next heading).
const section = (text: string, title: string) => units(text).find((u) => u.path.at(-1) === title)!.text;
// The failures after an edit of d.md from `before` (with its ledger) to `after`.
const edit = (before: string, after: string) => failures(verifyLedger([{ doc: "d.md", text: after }], entriesOf([{ doc: "d.md", text: before }]), {}, sha256));
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

describe("the toy library", () => {
  const base: LedgerDoc[] = [{ doc: DOC, text: libraryText }];
  const ledger = entriesOf(base);
  const run = (text: string, ontology: unknown = library, entries = ledger) => failures(verifyLedger([{ doc: DOC, text }], entries, ontology, sha256));

  it("a ledger for library.md passes", () => {
    const r = verifyLedger(base, ledger, library, sha256);
    expect(failures(r)).toEqual([]);
    expect(r.ok).toBe(true);
    // the preamble is empty (the document starts with its heading); the top heading and the 14 sections have text
    expect([r.units, r.emptyUnits]).toEqual([15, 1]);
  });

  it("edit a unit: changed", () => {
    expect(run(libraryText.replace("one physical copy", "one printed copy"))).toEqual(["changed L1 Book"]);
  });

  it("add a heading: unreviewed, and the outline (a new key)", () => {
    expect(run(libraryText.replace("## L2 Member\n", "## L2a Note\n\nA note.\n\n## L2 Member\n"))).toEqual(["unreviewed L2a Note", `outline ${DOC}`]);
  });

  it("rename a heading: stale and unreviewed, and the outline (a key changed)", () => {
    expect(run(libraryText.replace("## L2 Member\n", "## L2 Members\n"))).toEqual(["unreviewed L2 Members", "stale L2 Member", `outline ${DOC}`]);
  });

  it("swap two sections: outline only", () => {
    const a = section(libraryText, "L12 Branch"), b = section(libraryText, "L13 Person");
    const swapped = libraryText.replace(a + b, b + a);
    expect(swapped).not.toBe(libraryText);
    expect(run(swapped)).toEqual([`outline ${DOC}`]);
  });

  it("move a sub-heading under another parent: stale, unreviewed and outline", () => {
    const detail = "### Detail\n\nA detail.\n\n";
    const before = libraryText.replace("## L2 Member\n", `${detail}## L2 Member\n`);
    const after = libraryText.replace("## L3 Loan\n", `${detail}## L3 Loan\n`);
    const entries = entriesOf([{ doc: DOC, text: before }]);
    expect(run(before, library, entries)).toEqual([]);
    expect(run(after, library, entries)).toEqual(["unreviewed Detail", "stale Detail", `outline ${DOC}`]);
    const r = verifyLedger([{ doc: DOC, text: after }], entries, library, sha256);
    expect(r.stale).toEqual([{ doc: DOC, path: [TOP, "L1 Book", "Detail"], n: 1 }]);
    expect(r.unreviewed.map((u) => u.path)).toEqual([[TOP, "L2 Member", "Detail"]]);
  });

  it("remove the ontology key that a claim names: dangling", () => {
    const o = structuredClone(library);
    delete o.stateMachines.Book;
    expect(run(libraryText, o)).toEqual(["dangling L4 Book State /stateMachines/Book"]);
  });

  it("add a trailing space: changed", () => {
    expect(run(libraryText.replace("A Member is a person who may borrow books.", "A Member is a person who may borrow books. "))).toEqual(["changed L2 Member"]);
  });

  it("CRLF or a BOM on the whole file: pass, no stale", () => {
    expect(run("﻿" + libraryText)).toEqual([]);
    expect(run(libraryText.replace(/\n/g, "\r\n"))).toEqual([]);
    expect(run("﻿" + libraryText.replace(/\n/g, "\r\n"))).toEqual([]);
  });
});

describe("unit cut", () => {
  it("the units are exactly the normalized text, and the hash is the sha256 of the unit text", () => {
    const text = "intro\n# A\nx\n## B\ny\n";
    const u = units(text);
    expect(u.map((x) => x.text)).toEqual(["intro\n", "# A\nx\n", "## B\ny\n"]);
    expect(u.map((x) => x.sha256)).toEqual(["intro\n", "# A\nx\n", "## B\ny\n"].map((t) => createHash("sha256").update(t).digest("hex")));
    expect(u.map((x) => x.path)).toEqual([[], ["A"], ["A", "B"]]);
    expect(u.map((x) => x.text).join("")).toBe(text);
  });

  it("a heading inside a fence does not start a unit", () => {
    const u = units("# A\n```\n# not a heading\n```\n# B\n");
    expect(u.map((x) => x.heading)).toEqual([null, "A", "B"]);
    expect(u[1].text).toBe("# A\n```\n# not a heading\n```\n");
  });

  it("the preamble is a unit; a document without headings is one unit", () => {
    const u = units("Some text.\n\n# A\nx\n");
    expect(u[0]).toMatchObject({ heading: null, path: [], n: 1, text: "Some text.\n\n", empty: false });
    expect(units("plain text\nno heading\n").map((x) => [x.path, x.text])).toEqual([[[], "plain text\nno heading\n"]]);
  });

  it("an empty container heading needs no entry, and it is in the paths and the outline", () => {
    const text = "# Top\n\n## A\nrule a\n";
    const u = units(text);
    expect(u.map((x) => [x.path, x.empty])).toEqual([[[], true], [["Top"], true], [["Top", "A"], false]]);
    const docs = [{ doc: "d.md", text }];
    const values = ledgerValues(docs);
    expect(values).toHaveLength(3); // header, outline, one unit
    expect(verifyLedger(docs, parseLedger(asLines(values)), {}, sha256).ok).toBe(true);
    // the empty heading is in the outline: removing it changes the outline (and the key of its child)
    const r = verifyLedger([{ doc: "d.md", text: "## A\nrule a\n" }], parseLedger(asLines(values)), {}, sha256);
    expect(r.outline).toHaveLength(1);
  });

  it("closing #s and white space are removed from a title; a level change changes the key", () => {
    expect(units("# A ##\n## B  \n").map((x) => x.path)).toEqual([[], ["A"], ["A", "B"]]);
    expect(units("# A\n### B\n## C\n").map((x) => x.path)).toEqual([[], ["A"], ["A", "B"], ["A", "C"]]);
  });

  it("a duplicate path gives n = 1 and n = 2; a third one inserted before them gives changed, not a pass", () => {
    const text = "# T\n## X\nfirst\n## X\nsecond\n";
    expect(units(text).filter((u) => u.path.at(-1) === "X").map((u) => u.n)).toEqual([1, 2]);
    const docs = [{ doc: "d.md", text }];
    const r = verifyLedger([{ doc: "d.md", text: "# T\n## X\nnew\n## X\nfirst\n## X\nsecond\n" }], parseLedger(asLines(ledgerValues(docs))), {}, sha256);
    expect(r.ok).toBe(false);
    expect(r.changed.map((u) => u.n)).toEqual([1, 2]);
    expect(r.unreviewed.map((u) => u.n)).toEqual([3]);
  });

  it("generated blocks are hashed as text: a change inside one fails, also inside a ~~~ fence", () => {
    const fenced = (v: string) => `~~~\n<!-- BEGIN GENERATED: g -->\nallow: ${v}\n<!-- END GENERATED: g -->\n~~~\n`;
    expect(edit(fenced("false"), fenced("true"))).toEqual(["changed undefined"]);
    const plain = (v: string) => `# A\n<!-- BEGIN GENERATED: g -->\nallow: ${v}\n<!-- END GENERATED: g -->\n`;
    expect(edit(plain("false"), plain("true"))).toEqual(["changed A"]);
    // a heading in a generated block is a heading; a marker that is not closed is text
    expect(units("# A\n<!-- BEGIN GENERATED: g -->\n# G\n<!-- END GENERATED: g -->\n").map((u) => u.path)).toEqual([[], ["A"], ["G"]]);
    expect(units("# A\n<!-- BEGIN GENERATED: g -->\n").map((u) => u.text)).toEqual(["", "# A\n<!-- BEGIN GENERATED: g -->\n"]);
  });

  it("the outline covers the heading line of each unit: closing #s and the level of an empty unit count", () => {
    expect(edit("<div>\n# A ##\n# B\n</div>\n", "<div>\n# A\n# B\n</div>\n")).toEqual(["outline d.md"]);
    expect(edit("# A\n## B\n", "# A\n### B\n")).toEqual(["outline d.md"]);
  });
});

// Expected units written by hand (not computed with docUnits), so that a cut error cannot be in the result and in the expectation.
describe("unit cut: golden documents", () => {
  const golden = (text: string) => units(text).map((u) => [u.path, u.n, u.text, u.empty, u.sha256]);
  it("headings of each level, a fence, closing #s, a repeated path and empty units", () => {
    const text = "Intro.\n\n# Top\n\n## A ##\nrule a\n```\n# not a heading\n```\n## B\n\n### A\nrule b\n## A\nagain\n";
    expect(golden(text)).toEqual([
      [[], 1, "Intro.\n\n", false, hex("Intro.\n\n")],
      [["Top"], 1, "# Top\n\n", true, hex("# Top\n\n")],
      [["Top", "A"], 1, "## A ##\nrule a\n```\n# not a heading\n```\n", false, hex("## A ##\nrule a\n```\n# not a heading\n```\n")],
      [["Top", "B"], 1, "## B\n\n", true, hex("## B\n\n")],
      [["Top", "B", "A"], 1, "### A\nrule b\n", false, hex("### A\nrule b\n")],
      [["Top", "A"], 2, "## A\nagain\n", false, hex("## A\nagain\n")],
    ]);
    const outline = '[[[],1,null],[["Top"],1,"# Top"],[["Top","A"],1,"## A ##"],[["Top","B"],1,"## B"],[["Top","B","A"],1,"### A"],[["Top","A"],2,"## A"]]';
    expect(outlineHash(units(text), sha256)).toBe(hex(outline));
  });

  it("a BOM and CRLF are normalized; the generated-block markers stay in the unit text", () => {
    const text = "\uFEFF# G\r\n<!-- BEGIN GENERATED: g -->\r\nx \r\n<!-- END GENERATED: g -->\r\n";
    const g = "# G\n<!-- BEGIN GENERATED: g -->\nx \n<!-- END GENERATED: g -->\n";
    expect(golden(text)).toEqual([[[], 1, "", true, hex("")], [["G"], 1, g, false, hex(g)]]);
    expect(outlineHash(units(text), sha256)).toBe(hex('[[[],1,null],[["G"],1,"# G"]]'));
  });

  it("a last line without a line break", () => {
    expect(golden("a\n# H\nlast")).toEqual([[[], 1, "a\n", false, hex("a\n")], [["H"], 1, "# H\nlast", false, hex("# H\nlast")]]);
  });
});

describe("pointers", () => {
  it("an array segment selects the element with that id, or the string element", () => {
    expect(resolvePointer(library, "/linkTypes/loan_book")).toBe(true);
    expect(resolvePointer(library, "/linkTypes/loan_book/via")).toBe(true);
    expect(resolvePointer(library, "/infrastructureStores/audit_log")).toBe(true);
    expect(resolvePointer(library, "/linkTypes/no_such_link")).toBe(false);
  });

  it("a key with a dot resolves; ~1 and ~0 are unescaped", () => {
    const o = { contexts: { "A.B": {} }, "a/b": { "m~n": 1 } };
    expect(resolvePointer(o, "/contexts/A.B")).toBe(true);
    expect(resolvePointer(o, "/a~1b/m~0n")).toBe(true);
    expect(resolvePointer(o, "/a/b")).toBe(false);
  });

  it("a numeric segment on an array is dangling", () => {
    expect(resolvePointer(library, "/linkTypes/0")).toBe(false);
    const docs = [{ doc: "d.md", text: "rule\n" }];
    const entries = parseLedger(asLines([{ avouchLedger: 1 }, { doc: "d.md", outline: outlineHash(units("rule\n"), sha256) }, { doc: "d.md", path: [], n: 1, sha256: sha256("rule\n"), claims: ["/linkTypes/0"] }]));
    expect(failures(verifyLedger(docs, entries, library, sha256))).toEqual(["dangling undefined /linkTypes/0"]);
  });
});

describe("ledger shape", () => {
  const H = { avouchLedger: 1 };
  const O = (doc: string) => ({ doc, outline: "0".repeat(64) });
  const U = (doc: string, path: string[], n = 1) => ({ doc, path, n, sha256: "a".repeat(64), noClaim: "x" });
  const cases: [string, unknown[], string][] = [
    ["an empty ledger", [], '1: missing header {"avouchLedger":1}'],
    ["an unknown version", [{ avouchLedger: 2 }], "1: unknown version 2"],
    ["no header", [O("a.md")], '1: the first line must be {"avouchLedger":1}'],
    ["a second header", [H, H], "2: the header is allowed on the first line only"],
    ["unsorted lines", [H, O("b.md"), O("a.md")], "3: not sorted: this entry must come before line 2 (order: doc, its outline entry, path element by element, n)"],
    ["a unit before its outline", [H, U("a.md", []), O("a.md")], "3: not sorted"],
    ["a duplicate key", [H, U("a.md", ["X"]), U("a.md", ["X"])], "3: duplicate key of line 2"],
    ["an unknown key", [H, { ...U("a.md", []), extra: 1 }], "2: extra: unknown key"],
    ["claims and noClaim", [H, { ...U("a.md", []), claims: ["/a"] }], "2: must have exactly one of claims and noClaim"],
    ["neither claims nor noClaim", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64) }], "2: must have exactly one of claims and noClaim"],
    ["an empty reason", [H, { ...U("a.md", []), noClaim: " " }], "2: noClaim: must be a non-empty reason"],
    ["empty claims", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: [] }], "2: claims: must be a non-empty array"],
    ["a duplicate claim", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: ["/a", "/a"] }], "2: claims[1]: duplicate of claims[0]"],
    ["a claim that is not a pointer", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: ["a.b"] }], '2: claims[0]: "a.b" is not a JSON Pointer'],
    ["the root pointer", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: [""] }], "2: claims[0]: the root is not a claim"],
    ["a ~ followed by 2", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: ["/a~2"] }], '2: claims[0]: "/a~2": ~ must be followed by 0 or 1'],
    ["a ~ at the end", [H, { doc: "a.md", path: [], n: 1, sha256: "a".repeat(64), claims: ["/a/b~"] }], '2: claims[0]: "/a/b~": ~ must be followed by 0 or 1'],
    ["n = 0", [H, U("a.md", [], 0)], "2: n: must be an integer from 1"],
    ["a bad hash", [H, { ...U("a.md", []), sha256: "ABC" }], "2: sha256: must be a sha256"],
  ];
  for (const [name, values, message] of cases)
    it(`${name}: ${message}`, () => expect(() => parseLedger(asLines(values))).toThrow(message));

  it("the order: doc, outline first, then path element by element (a prefix first), then n", () => {
    const sorted = [O("a.md"), U("a.md", []), U("a.md", ["A"]), U("a.md", ["A"], 2), U("a.md", ["A", "B"]), U("a.md", ["B"]), O("b.md"), U("b.md", [])];
    expect(parseLedger(asLines([H, ...sorted]))).toHaveLength(sorted.length);
  });

  it("the failing units are in ledger order, each with its ledger line without the decision", () => {
    const r = verifyLedger([{ doc: "b.md", text: "# B\nx\n# A\ny\n" }, { doc: "a.md", text: "z\n" }], parseLedger(asLines([H])), {}, sha256);
    expect(r.unreviewed.map((u) => [u.doc, u.path])).toEqual([["a.md", []], ["b.md", ["A"]], ["b.md", ["B"]]]);
    expect(r.unreviewed[1].entry).toBe(`{"doc":"b.md","path":["A"],"n":1,"sha256":"${hex("# A\ny\n")}"}`);
  });

  it("an outline entry of a document that is not configured is stale", () => {
    const r = verifyLedger([], parseLedger(asLines([H, O("gone.md"), U("gone.md", [])])), {}, sha256);
    expect(failures(r)).toEqual(["stale gone.md outline", "stale undefined"]);
  });

  it.skipIf(!gitAvailable)("two branches that edit units of different documents merge in git without a conflict", () => {
    const d = directory();
    const docs = (a: string, b: string) => [{ doc: "a.md", text: a }, { doc: "b.md", text: b }];
    const A = "# A\none\n# A2\ntwo\n# A3\nthree\n", B = "# B\none\n# B2\ntwo\n# B3\nthree\n";
    const A1 = A.replace("three", "THREE"), B1 = B.replace("one", "ONE");
    const base = write(join(d, "base"), jsonl(ledgerValues(docs(A, B))));
    // branch 1 edits the last unit of a.md, branch 2 the first unit of b.md: the outline line of b.md is between them
    const ours = write(join(d, "ours"), jsonl(ledgerValues(docs(A1, B))));
    const theirs = write(join(d, "theirs"), jsonl(ledgerValues(docs(A, B1))));
    const m = git(d, "merge-file", "-p", ours, base, theirs);
    expect(m.status, m.stdout).toBe(0);
    expect(m.stdout).toBe(jsonl(ledgerValues(docs(A1, B1))));
  });
});

describe("avouch gate docs", () => {
  const runIn = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, "gate", "docs", ...args], { cwd, encoding: "utf8" });
  // A project: the toy ontology at avouch/, the toy document at docs/, a configuration and a ledger.
  const project = (config: Record<string, unknown>, ledger?: unknown[]) => {
    const d = directory();
    write(join(d, "avouch/avouch.ontology.yaml"), libraryOntologyText);
    write(join(d, "docs/library.md"), libraryText);
    write(join(d, "avouch.config.json"), JSON.stringify({ ontology: "avouch/avouch.ontology.yaml", ...config }));
    write(join(d, "avouch.ledger.jsonl"), jsonl(ledger ?? ledgerValues([{ doc: "docs/library.md", text: libraryText }])));
    return d;
  };
  const inline = { adapter: { markdown: { docs: ["docs/library.md"] } } };

  it("passes with the ledger of the toy, and fails with exit 1 after an edit", () => {
    const d = project(inline);
    const pass = runIn(d, "--config", "avouch.config.json");
    expect(pass.status, pass.stderr).toBe(0);
    expect(pass.stdout).toBe("PASS: 1 document(s), 15 unit(s), 1 empty unit(s); 0 changed, 0 unreviewed, 0 stale, 0 outline, 0 dangling\n");
    write(join(d, "docs/library.md"), libraryText.replace("one physical copy", "one printed copy"));
    const fail = runIn(d, "--config", "avouch.config.json");
    expect(fail.status).toBe(1);
    expect(fail.stdout.split("\n")[0]).toBe(`FAIL changed docs/library.md ${JSON.stringify([TOP, "L1 Book"])} 1`);
    const json = runIn(d, "--config", "avouch.config.json", "--json");
    expect(json.status).toBe(1);
    const out = JSON.parse(json.stdout);
    expect(out).toMatchObject({ avouchGate: 1, gate: "docs", result: { ok: false } });
    const h = sha256(section(readFileSync(join(d, "docs/library.md"), "utf8"), "L1 Book"));
    const entry = JSON.stringify({ doc: "docs/library.md", path: [TOP, "L1 Book"], n: 1, sha256: h });
    expect(out.result.changed).toEqual([{ doc: "docs/library.md", path: [TOP, "L1 Book"], n: 1, sha256: h, firstLine: "## L1 Book", entry }]);
  });

  it("the ledger file and the docs can be set in ledger", () => {
    const d = project({ adapter: "tools/adapter.mjs", ledger: { file: "review/ledger.jsonl", docs: ["./docs/library.md"] } });
    write(join(d, "review/ledger.jsonl"), readFileSync(join(d, "avouch.ledger.jsonl"), "utf8"));
    const r = runIn(d, "--config", "avouch.config.json");
    expect(r.status, r.stderr).toBe(0);
  });

  it("an absolute ledger.file works", () => {
    const d = project(inline);
    const file = write(join(d, "review/ledger.jsonl"), readFileSync(join(d, "avouch.ledger.jsonl"), "utf8"));
    write(join(d, "avouch.config.json"), JSON.stringify({ ontology: "avouch/avouch.ontology.yaml", ...inline, ledger: { file } }));
    const r = runIn(d, "--config", "avouch.config.json");
    expect(r.status, r.stderr).toBe(0);
  });

  it("a ledger file with a BOM passes", () => {
    const d = project(inline);
    write(join(d, "avouch.ledger.jsonl"), "\uFEFF" + readFileSync(join(d, "avouch.ledger.jsonl"), "utf8"));
    const r = runIn(d, "--config", "avouch.config.json");
    expect(r.status, r.stderr).toBe(0);
  });

  it("one file named twice (a hard link, or a case variant on a case-insensitive file system) gives exit 2", () => {
    const d = project(inline);
    linkSync(join(d, "docs/library.md"), join(d, "docs/copy.md"));
    const variants = [["docs/library.md", "docs/copy.md"], ...(existsSync(join(d, "docs/LIBRARY.md")) ? [["docs/library.md", "docs/LIBRARY.md"]] : [])];
    for (const docs of variants) {
      write(join(d, "avouch.config.json"), JSON.stringify({ ontology: "avouch/avouch.ontology.yaml", ...inline, ledger: { docs } }));
      const r = runIn(d, "--config", "avouch.config.json");
      expect(r.status, docs.join(" ")).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^avouch\\.config\\.json: ledger: document ${docs[1]} is named twice`));
    }
  });

  it("a module adapter without ledger.docs gives exit 2", () => {
    const d = project({ adapter: "tools/adapter.mjs" });
    const r = runIn(d, "--config", "avouch.config.json");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^avouch\.config\.json: ledger\.docs: missing \(required with a module adapter\); usage: avouch gate docs/);
  });

  it("the docs of an external Markdown configuration are relative to avouch.config.json", () => {
    const d = project({ adapter: "avouch/avouch.json" }, [{ avouchLedger: 1 }]);
    write(join(d, "avouch/avouch.json"), JSON.stringify({ docs: ["../docs/library.md"] }));
    const r = runIn(d, "--config", "avouch.config.json", "--json");
    expect(r.status, r.stderr).toBe(1);
    const result = JSON.parse(r.stdout).result;
    expect(result.outline).toEqual([{ doc: "docs/library.md", sha256: outlineHash(docUnits({ doc: "x", text: libraryText }, sha256), sha256) }]);
    expect(new Set(result.unreviewed.map((u: { doc: string }) => u.doc))).toEqual(new Set(["docs/library.md"]));
  });

  const shapeCases: [string, (l: unknown[]) => unknown[], RegExp][] = [
    ["unsorted lines", (l) => [l[0], l[2], l[1], ...l.slice(3)], /^\/\S*\/avouch\.ledger\.jsonl:3: not sorted/],
    ["a duplicate key", (l) => [...l.slice(0, 3), l[2], ...l.slice(3)], /^\/\S*\/avouch\.ledger\.jsonl:4: duplicate key of line 3/],
    ["an unknown key", (l) => [l[0], { ...(l[1] as object), extra: true }, ...l.slice(2)], /^\/\S*\/avouch\.ledger\.jsonl:2: extra: unknown key/],
    ["an unknown version", (l) => [{ avouchLedger: 2 }, ...l.slice(1)], /^\/\S*\/avouch\.ledger\.jsonl:1: unknown version 2/],
    ["the root pointer", (l) => l.map((v) => (Object.hasOwn(v as object, "claims") ? { ...(v as object), claims: [""] } : v)), /^\/\S*\/avouch\.ledger\.jsonl:\d+: claims\[0\]: the root is not a claim/],
  ];
  for (const [name, mutate, message] of shapeCases)
    it(`${name}: exit 2 with <ledger>:<line>: <reason>`, () => {
      const d = project(inline, mutate(ledgerValues([{ doc: "docs/library.md", text: libraryText }])));
      const r = runIn(d, "--config", "avouch.config.json");
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(r.stderr).toMatch(message);
    });

  it("a missing ledger, an invalid line and a missing document give exit 2", () => {
    const d = project(inline);
    rmSync(join(d, "avouch.ledger.jsonl"));
    expect(runIn(d, "--config", "avouch.config.json").stderr).toMatch(/^\/\S*\/avouch\.ledger\.jsonl: file not found/);
    write(join(d, "avouch.ledger.jsonl"), '{"avouchLedger":1}\n\n{\n');
    const bad = runIn(d, "--config", "avouch.config.json");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^\/\S*\/avouch\.ledger\.jsonl:3: invalid JSON/);
    const e = project({ adapter: { markdown: { docs: ["docs/missing.md"] } } });
    const missing = runIn(e, "--config", "avouch.config.json");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/^avouch\.config\.json: ledger: docs\/missing\.md: /);
  });

  const configCases: [string, unknown, string][] = [
    ["ledger not an object", [], "ledger: must be an object"],
    ["an unknown ledger key", { other: 1 }, "ledger.other: unknown key"],
    ["an empty file", { file: "" }, "ledger.file: must be a non-empty string"],
    ["empty docs", { docs: [] }, "ledger.docs: must be a non-empty array of strings"],
    ["a duplicate doc", { docs: ["a.md", "a.md"] }, "ledger.docs[1]: duplicate of ledger.docs[0]"],
  ];
  for (const [name, ledger, message] of configCases)
    it(`avouch.config.json: ${name}`, () => {
      const r = runIn(project({ ...inline, ledger }), "--config", "avouch.config.json");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`avouch.config.json: ${message}`);
    });

  it("the ledger key does not change the other commands", () => {
    const d = project({ ...inline, ledger: { docs: ["docs/library.md"] } });
    const r = spawnSync(process.execPath, [cli, "query", "action", "BORROW", "--config", "avouch.config.json"], { cwd: d, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("usage errors give exit 2 and the usage of gate docs", () => {
    const d = project(inline);
    for (const args of [["--frobnicate"], ["extra"], ["--config"]]) {
      const r = runIn(d, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: avouch gate docs");
    }
  });
});

// The command line with an ontology that lacks the place that a claim names.
describe("avouch gate docs: dangling", () => {
  it("a claim that the ontology does not have fails with exit 1", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "avouch-ledger-")));
    directories.push(d);
    const o = structuredClone(library);
    delete o.linkTypes;
    write(join(d, "o.yaml"), stringify(o));
    write(join(d, "library.md"), libraryText);
    write(join(d, "avouch.config.json"), JSON.stringify({ ontology: "o.yaml", adapter: { markdown: { docs: ["library.md"] } } }));
    write(join(d, "avouch.ledger.jsonl"), jsonl(ledgerValues([{ doc: "library.md", text: libraryText }])));
    const r = spawnSync(process.execPath, [cli, "gate", "docs", "--config", "avouch.config.json"], { cwd: d, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe(`FAIL dangling library.md ${JSON.stringify([TOP, "L3 Loan"])} 1 /linkTypes/loan_book`);
  });
});
