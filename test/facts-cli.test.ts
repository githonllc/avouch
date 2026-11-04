import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const library = join(root, "examples/library/library.md");
const libraryOntology = join(root, "examples/library/library.ontology.yaml");
const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/library-markdown.json"), "utf8"));
const adapterFixture = "test/fixtures/library-markdown.json";
const directories: string[] = [];
const run = (...args: string[]) => spawnSync(process.execPath, ["dist/cli/avouch.js", ...args], { cwd: root, encoding: "utf8" });
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), "avouch-facts-"));
  directories.push(d);
  return d;
};
const write = (name: string, text: string) => {
  const path = join(directory(), name);
  writeFileSync(path, text);
  return path;
};
const lines = (s: string) => s.trimEnd().split("\n");
// The toy ontology without evidence ids, with a waiver for the evidence that the Markdown adapter does not read.
const waived = () => {
  const o = parse(readFileSync(libraryOntology, "utf8"));
  for (const a of Object.values(o.actionTypes as Record<string, Record<string, unknown>>)) delete a.evidence;
  o.knownSourceGaps = [{ id: "NO-EVIDENCE", rule: "R6", kind: "fact_missing", keys: ["facts.evidence"], doc_line: "test", conflict: "test", proposed: "test" }];
  return stringify(o);
};
// An adapter configuration (a .json file) over one document.
const adapterFor = (doc: string, extra: Record<string, unknown> = {}) => write("adapter.json", JSON.stringify({ ...fixture, docs: [write("doc.md", doc)], ...extra }));
const toyJson = () => JSON.parse(run("facts", "--adapter", adapterFixture, "--json").stdout);

afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("avouch facts", () => {
  it("the toy library: exit 0, one FACT line per fact key, one FIELDS line per text block", () => {
    const r = run("facts", "--adapter", adapterFixture);
    expect(r.status, r.stderr).toBe(0);
    const out = lines(r.stdout);
    expect(out).toContain("FACT storeCatalog L8: 6 names");
    expect(out).toContain("FACT permissions L10: 2 catalog names, 2 rows");
    expect(out).toContain("FACT stateMachines.Book L4: 3 states, 3 edges");
    expect(out).toContain("FACT transitionTriggers L6: 3 edges");
    expect(out).toContain("FIELDS L1#Book: 4 field(s)");
    expect(out.at(-1)).toBe("OK: 0 diagnostic(s)");
  });

  it("says which facts are not configured", () => {
    const r = run("facts", "--adapter", adapterFor("# A\n\n```text\nbooks\n```\n", { facts: { storeCatalog: "A" } }));
    expect(r.status, r.stderr).toBe(0);
    for (const n of ["eventCatalog", "contextMembers", "permissions", "scenarios", "stateMachines", "transitionTriggers"]) expect(r.stdout).toContain(`FACT ${n}: not configured`);
    expect(r.stdout).toContain("FACT storeCatalog A: 1 names");
  });

  it("a broken state diagram: DIAG line and exit 1", () => {
    const doc = readFileSync(library, "utf8").replace(/^(\s*)\[\*\] --> AVAILABLE$/m, "$1A -> B");
    expect(doc).not.toBe(readFileSync(library, "utf8"));
    const r = run("facts", "--adapter", adapterFor(doc, { facts: fixture.facts }));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/^DIAG R3 markdown_parse facts\.stateMachines\./m);
    expect(lines(r.stdout).at(-1)).toMatch(/^FAIL: \d+ diagnostic\(s\)$/);
  });

  it("a module adapter is an error, from --adapter and from the configuration", () => {
    const a = run("facts", "--adapter", "test/fixtures/library-adapter.mjs");
    expect(a.status).toBe(2);
    expect(lines(a.stderr)).toEqual(["facts: the adapter must be a Markdown configuration"]);
    const config = write("avouch.config.json", JSON.stringify({ adapter: join(root, "test/fixtures/library-adapter.mjs") }));
    const c = run("facts", "--config", config);
    expect(c.status).toBe(2);
    expect(lines(c.stderr)).toEqual(["facts: the adapter must be a Markdown configuration"]);
  });

  it("no adapter: exit 2 with one line", () => {
    const config = write("avouch.config.json", JSON.stringify({ ontology: "o.yaml", adapter: "x.json" }));
    const r = run("facts", "--config", config);
    expect(r.status).toBe(2);
    expect(lines(r.stderr)).toEqual([`${config}: adapter: file not found`]);
  });

  it("a line that is not a field line is a WARN and does not change the exit code", () => {
    const r = run("facts", "--adapter", adapterFor("# A Things\n\n```text\nThing\n- id\n* other\n// note\n\n- name?\n```\n", { facts: {} }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("FIELDS A#Thing: 2 field(s)");
    expect(r.stdout).toMatch(/^WARN \S*doc\.md:6: A#Thing: line is not a field line: \* other$/m);
    expect(r.stdout).not.toContain("// note");
  });

  it("--json: sorted sets, sorted maps, fields with nullable", () => {
    const j = toyJson();
    expect(Object.keys(j)).toEqual(["facts", "fields", "warnings", "diagnostics"]);
    expect(j.facts.storeCatalog).toEqual(["audit_log", "books", "branches", "loans", "members", "people"]);
    expect(j.facts.permissions).toEqual({ catalog: ["loan:close", "loan:create"], rows: { BORROW: ["loan:create"], RETURN: ["loan:close"] } });
    expect(j.facts.scenarios).toEqual({ S1: ["BORROW"], S2: ["RETURN"] });
    expect(j.facts.stateMachines.Book.nodes).toEqual(["AVAILABLE", "ON_LOAN", "WITHDRAWN"]);
    expect(j.facts.stateMachines.Book.initial).toEqual(["AVAILABLE"]);
    expect(j.facts.stateMachines.Book.edges).toContain("AVAILABLE->ON_LOAN");
    expect(Object.keys(j.facts.transitionTriggers.Book)).toEqual([...Object.keys(j.facts.transitionTriggers.Book)].sort());
    expect(j.facts.contextMembers.Catalog).toEqual(["Book"]);
    expect(j.fields["L2#Member"].person_id).toEqual({ nullable: true });
    expect(j.fields["L2#Member"].open_loans).toEqual({ nullable: false });
    expect(j.diagnostics).toEqual([]);
  });

  describe("--inventory", () => {
    const inventory = (j: { facts: unknown; fields: unknown }) => write("inventory.json", JSON.stringify({ conventionVersion: 1, facts: j.facts, fields: j.fields, prose: ["a note"] }));

    it("equal: exit 0", () => {
      const r = run("facts", "--adapter", adapterFixture, "--inventory", inventory(toyJson()));
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).not.toContain("DIFF");
    });

    it("one nullable flag flipped: DIFF line and exit 1", () => {
      const j = toyJson();
      j.fields["L2#Member"].person_id.nullable = false;
      const r = run("facts", "--adapter", adapterFixture, "--inventory", inventory(j));
      expect(r.status, r.stderr).toBe(1);
      expect(lines(r.stdout)).toContain("DIFF fields.L2#Member.person_id.nullable: inventory false, document true");
    });

    it("a fact missing from the document and an extra set member: DIFF lines", () => {
      const j = toyJson();
      j.facts.storeCatalog.push("extra");
      j.facts.extraFact = [];
      const r = run("facts", "--adapter", adapterFixture, "--inventory", inventory(j));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("DIFF facts.storeCatalog:");
      expect(r.stdout).toContain("DIFF facts.extraFact: inventory [], document (absent)");
    });

    it.each([
      ["not JSON", "{"],
      ["not an object", "[]"],
      ["no conventionVersion", JSON.stringify({ facts: {}, fields: {}, prose: [] })],
      ["facts not an object", JSON.stringify({ conventionVersion: 1, facts: [], fields: {}, prose: [] })],
      ["prose missing", JSON.stringify({ conventionVersion: 1, facts: {}, fields: {} })],
    ])("malformed (%s): exit 2", (_name, text) => {
      const r = run("facts", "--adapter", adapterFixture, "--inventory", write("inventory.json", text));
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(lines(r.stderr)).toHaveLength(1);
    });
  });

  it("usage: unknown option, and no arguments lists the command", () => {
    const r = run("facts", "--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: avouch facts [--config <avouch.config.json>] [--adapter <config.json>] [--json] [--inventory <file.json>]");
    const none = run();
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("usage: avouch facts ");
  });
});

describe("a configuration without ontology", () => {
  const config = () => write("avouch.config.json", JSON.stringify({ adapter: { markdown: { ...fixture, docs: [library] } } }));

  it("facts runs with the adapter of the configuration", () => {
    const r = run("facts", "--config", config());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("FACT storeCatalog L8: 6 names");
  });

  it("check without -f: ontology: missing, exit 2", () => {
    const c = config();
    const r = run("check", "--config", c);
    expect(r.status).toBe(2);
    expect(lines(r.stderr)).toEqual([`${c}: ontology: missing`]);
    expect(r.stdout).toBe("");
  });

  it("check -f uses the adapter of the configuration", () => {
    const r = run("check", "-f", write("o.yaml", waived()), "--config", config());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(r.stdout).at(-1)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
  });

  it("an ontology that is present must still be a non-empty string", () => {
    const c = write("avouch.config.json", JSON.stringify({ ontology: "", adapter: "x.json" }));
    const r = run("facts", "--config", c);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${c}: ontology: must be a non-empty string`);
  });
});
