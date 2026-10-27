// avouch reconcile: RuntimeCase JSON lines in, ReconcileRow JSON lines out. Toy library only: RETURN on Loan.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import type { Value } from "../src/evaluate";
import type { Stage1Ontology } from "../src/expr";
import { projectSnapshot, reconcile, type Decode, type RuntimeCase } from "../src/reconcile";

const root = fileURLToPath(new URL("../", import.meta.url));
const ontology = "examples/library/library.ontology.yaml";
const library = parse(ontologyText) as Stage1Ontology;
const identity: Decode = (raw) => raw as Value;
const directories: string[] = [];
const run = (...args: string[]) => spawnSync(process.execPath, ["dist/cli/avouch.js", "reconcile", ...args], { cwd: root, encoding: "utf8" });
const temporaryFile = (name: string, text: string) => {
  const directory = mkdtempSync(join(tmpdir(), "avouch-reconcile-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const LOAN = { id: "LN-1", branch_id: "BR-1", state: "ACTIVE", due_date: "2026-01-15", return_condition: null };
const baseStores = () => ({ branches: [{ id: "BR-1", timezone: "UTC" }], loans: [{ ...LOAN }], people: [], members: [], books: [] });

// The baseline case; each case overrides only the fields it names.
function baseCase(over: Partial<RuntimeCase> = {}, stores = baseStores()): RuntimeCase {
  return {
    id: "inv-1",
    action: "RETURN",
    snapshot: projectSnapshot(library, stores, identity).snapshot,
    inputs: { bindings: { loan_id: "LN-1" }, actor: { id: "P-1", kind: "person", keys: ["loan:close"] }, scope: "BR-1", now: Date.UTC(2026, 0, 10) },
    reported: { result: "RETURNED" },
    expected: { result: "RETURNED" },
    ...over,
  };
}
// One case for each RETURN unit: rows.0 (REJECTED), rows.1 (RETURNED_LATE), otherwise (RETURNED).
const returnCases = (): RuntimeCase[] => {
  const base = baseCase();
  return [
    baseCase({ id: "inv-0", reported: { result: "REJECTED" }, expected: { result: "REJECTED" } }, { ...baseStores(), loans: [{ ...LOAN, state: "RETURNED" }] }),
    baseCase({ id: "inv-1", inputs: { ...base.inputs, now: Date.UTC(2026, 0, 20) }, reported: { result: "RETURNED_LATE" }, expected: { result: "RETURNED_LATE" } }),
    baseCase({ id: "inv-2" }),
  ];
};
const jsonl = (cases: unknown[], eol = "\n") => cases.map((c) => JSON.stringify(c)).join(eol) + eol;
const lines = (stdout: string) => stdout.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

describe("avouch reconcile", () => {
  it("prints one reconcile row per case, in input order", () => {
    const cases = returnCases();
    const r = run("-f", ontology, "--cases", temporaryFile("cases.jsonl", jsonl(cases)));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(lines(r.stdout)).toHaveLength(3);
    expect(lines(r.stdout)).toEqual(reconcile(library, cases));
    expect(lines(r.stdout).map((x) => x.row)).toEqual([0, 1, "otherwise"]);
  });

  it("skips empty lines and accepts CRLF line ends", () => {
    const [a, b, c] = returnCases().map((x) => JSON.stringify(x));
    const r = run("--cases", temporaryFile("cases.jsonl", `${a}\r\n\r\n${b}\r\n${c}\r\n`), "-f", ontology);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(r.stdout)).toHaveLength(3);
  });

  it("a line that is not JSON gives exit 2 and its line number", () => {
    const [a] = returnCases();
    const r = run("-f", ontology, "--cases", temporaryFile("cases.jsonl", `${JSON.stringify(a)}\n{nope\n`));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cases.jsonl:2: invalid JSON");
    expect(r.stderr).toContain("usage: avouch reconcile");
    expect(r.stdout).toBe("");
  });

  it("a line that is not a RuntimeCase gives exit 2, its line number and the field", () => {
    const { expected: _expected, ...noExpected } = returnCases()[0];
    const r = run("-f", ontology, "--cases", temporaryFile("cases.jsonl", jsonl([noExpected])));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(":1: expected");
    expect(r.stdout).toBe("");
  });

  it("does not judge the rows: a mismatch gives exit 0", () => {
    const r = run("-f", ontology, "--cases", temporaryFile("cases.jsonl", jsonl([baseCase({ reported: { result: "RETURNED_LATE" } })])));
    expect(r.status, r.stderr).toBe(0);
    expect(lines(r.stdout)[0]).toMatchObject({ status: "mismatch" });
  });

  it("invalid arguments give exit 2", () => {
    const cases = temporaryFile("cases.jsonl", jsonl(returnCases()));
    for (const args of [
      ["-f", ontology],
      ["-f", ontology, ontology, "--cases", cases],
      ["-f", ontology, "--cases", cases, "--x"],
      ["-f", ontology, "--cases", cases, "-z"],
      ["-f", ontology, "--cases"],
      ["-f", "--cases", cases],
      ["-f", ontology, "-f", ontology, "--cases", cases],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: avouch reconcile");
      expect(r.stdout).toBe("");
    }
  });

  it("an ontology whose root is not a mapping gives exit 2", () => {
    const r = run("-f", temporaryFile("ontology.yaml", "- a\n- b\n"), "--cases", temporaryFile("cases.jsonl", jsonl(returnCases())));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("the root is not a mapping");
  });
});
