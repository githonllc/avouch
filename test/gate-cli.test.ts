// avouch gate verify: decision-row coverage of reconcile rows from a file, with a baseline. Toy library only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import type { Value } from "../src/evaluate";
import type { Stage1Ontology } from "../src/expr";
import { applyPatch } from "../src/patch";
import { queryAction, verifyCoverage } from "../src/index";
import { projectSnapshot, type Decode, type ReconcileRow, type RuntimeCase } from "../src/reconcile";

const root = fileURLToPath(new URL("../", import.meta.url));
const ontology = "examples/library/library.ontology.yaml";
const adapter = "test/fixtures/library-adapter.mjs";
const library = parse(ontologyText) as Stage1Ontology;
const identity: Decode = (raw) => raw as Value;
const directories: string[] = [];
const avouch = (...args: string[]) => spawnSync(process.execPath, ["dist/cli/avouch.js", ...args], { cwd: root, encoding: "utf8" });
const temporaryFile = (name: string, text: string) => {
  const directory = mkdtempSync(join(tmpdir(), "avouch-gate-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
};
const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1)!;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const LOAN = { id: "LN-1", branch_id: "BR-1", state: "ACTIVE", due_date: "2026-01-15", return_condition: null };
const baseStores = () => ({ branches: [{ id: "BR-1", timezone: "UTC" }], loans: [{ ...LOAN }], people: [], members: [], books: [] });

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
const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

// The rows file of the three RETURN cases, written by avouch reconcile.
const rowsFile = (cases: RuntimeCase[] = returnCases()) => {
  const r = avouch("reconcile", ontology, "--cases", temporaryFile("cases.jsonl", jsonl(cases)));
  expect(r.status, r.stderr).toBe(0);
  return temporaryFile("rows.jsonl", r.stdout);
};
const debt = (action: string, row: number | "otherwise") => {
  const r = queryAction(library, action)!.decision!.rows.find((x) => x.row === row)!;
  return { action, row, when: r.when, result: r.result! };
};
const borrowDebts = () => ([0, 1, 2, 3, "otherwise"] as const).map((r) => debt("BORROW", r));
const baselineFile = (uncovered: unknown[], exempt: unknown[] = []) => temporaryFile("baseline.json", JSON.stringify({ avouchCoverage: 1, uncovered, exempt }, null, 2) + "\n");

describe("avouch gate verify", () => {
  it("passes on the pipeline from cases to the gate with a baseline of the BORROW units", () => {
    const r = avouch("gate", "verify", ontology, "--rows", rowsFile(), "--baseline", baselineFile(borrowDebts()));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout).startsWith("PASS: 8 unit(s), 3 verified, 5 baselined, 0 blocked, 0 uncovered;")).toBe(true);
    expect(r.stdout).toContain("INFO check not_run");
  });

  it("without a baseline, each uncovered unit fails", () => {
    const r = avouch("gate", "verify", "--rows", rowsFile(), ontology);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("FAIL uncovered BORROW:rows.0\n");
    expect(r.stdout).toContain("FAIL uncovered BORROW:otherwise\n");
    expect(lastLine(r.stdout)).toMatch(/^FAIL: /);
  });

  it("a baseline entry for a verified unit is stale", () => {
    const r = avouch("gate", "verify", ontology, "--rows", rowsFile(), "--baseline", baselineFile([...borrowDebts(), debt("RETURN", "otherwise")]));
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("FAIL stale uncovered RETURN:otherwise verified\n");
  });

  it("--json prints the envelope with the result of verifyCoverage", () => {
    const rows = rowsFile();
    const uncovered = borrowDebts();
    const r = avouch("gate", "verify", ontology, "--rows", rows, "--baseline", baselineFile(uncovered), "--json");
    expect(r.status, r.stderr).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.avouchGate).toBe(1);
    expect(envelope.gate).toBe("verify");
    expect(envelope.check).toEqual({ status: "not_run" });
    const parsed = readFileSync(rows, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ReconcileRow);
    expect(envelope.result).toEqual(verifyCoverage(library, parsed, { avouchCoverage: 1, uncovered, exempt: [] }));
  });

  it("with --adapter, runs the check, and a failed check fails the gate", () => {
    const rows = rowsFile();
    const pass = avouch("gate", "verify", ontology, "--rows", rows, "--baseline", baselineFile(borrowDebts()), "--adapter", adapter);
    expect(pass.status, pass.stdout + pass.stderr).toBe(0);
    expect(pass.stdout).toContain("INFO check pass\n");
    const mutation = parse(readFileSync(join(root, "examples/library/mutations/lib-r8-unknown-event.yaml"), "utf8"));
    const bad = temporaryFile("ontology.yaml", stringify(applyPatch(parse(ontologyText), mutation.patch)));
    const fail = avouch("gate", "verify", bad, "--rows", rows, "--baseline", baselineFile(borrowDebts()), "--adapter", adapter);
    expect(fail.status, fail.stderr).toBe(1);
    expect(fail.stdout).toContain("FAIL check: ");
    expect(fail.stdout).toContain("INFO check fail\n");
  });

  it("invalid input gives exit 2 and the usage", () => {
    const rows = rowsFile();
    const badBaseline = temporaryFile("baseline.json", JSON.stringify({ avouchCoverage: 2, uncovered: [], exempt: [] }));
    const badRows = temporaryFile("rows.jsonl", "{nope\n");
    for (const args of [
      ["gate", "verify", ontology, "--rows", rows, "--baseline", badBaseline],
      ["gate", "verify", ontology, "--rows", badRows],
      ["gate", "verify", ontology],
      ["gate"],
      ["gate", "plan", ontology],
    ]) {
      const r = avouch(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: avouch gate verify");
      expect(r.stdout).toBe("");
    }
    expect(avouch("gate", "verify", ontology, "--rows", rows, "--baseline", badBaseline).stderr).toContain("baseline.json: baseline: avouchCoverage");
    expect(avouch("gate", "verify", ontology, "--rows", badRows).stderr).toContain("rows.jsonl:1: invalid JSON");
  });

  it("an exemption without a reason fails; the units of the gap are blocked", () => {
    const ont = structuredClone(library);
    ont.actionTypes.RETURN!.conditions = ont.actionTypes.RETURN!.conditions.map((c) => (c.id === "loan_active" ? { id: "loan_active", unspecified: "x" } : c));
    const path = temporaryFile("ontology.yaml", stringify(ont));
    const r = avouch("gate", "verify", path, "--rows", temporaryFile("rows.jsonl", ""), "--baseline", baselineFile(borrowDebts(), [{ action: "RETURN", condition: "loan_active", kind: "unspecified" }]));
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("FAIL unreasoned RETURN:loan_active\n");
    expect(r.stdout).toContain("INFO blocked RETURN:rows.0 by loan_active\n");
  });

  it("cases without an expectation are unasserted: printed as INFO and counted in the summary", () => {
    const cases = [baseCase({ id: "u-1", expected: null }), ...returnCases(), baseCase({ id: "u-2", expected: null })];
    const r = avouch("gate", "verify", ontology, "--rows", rowsFile(cases), "--baseline", baselineFile(borrowDebts()));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("INFO unasserted u-1 RETURN\n");
    expect(r.stdout).toContain("INFO unasserted u-2 RETURN\n");
    expect(lastLine(r.stdout)).toContain("2 unasserted");
  });
});

describe("avouch without a known command", () => {
  it("prints the four usages and exits with 2", () => {
    const r = avouch();
    expect(r.status).toBe(2);
    for (const usage of ["usage: avouch check", "usage: avouch query", "usage: avouch reconcile", "usage: avouch gate verify"]) expect(r.stderr).toContain(usage);
  });
});
