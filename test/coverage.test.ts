// Decision-row coverage (src/coverage.ts): which decision rows the reconciled cases verify, with a baseline of
// uncovered units and exempted gaps. Toy library only: BORROW has 4 rows and otherwise, RETURN has 2 rows and otherwise.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import { applyPatch, projectSnapshot, queryAction, reconcile, verifyCoverage, type CoverageBaseline, type ReconcileRow, type RuntimeCase, type Stage1Ontology, type Value } from "../src/index";
import type { Op } from "../src/patch";

const library = parse(ontologyText) as Stage1Ontology;
type Row = number | "otherwise";

const unit = (action: string, row: Row) => ({ action, row });
// A baseline entry for a unit, with the when and result of that row in the given ontology.
const debt = (action: string, row: Row, ont: unknown = library) => {
  const r = queryAction(ont, action)!.decision!.rows.find((x) => x.row === row)!;
  return { action, row, when: r.when, result: r.result! };
};
const baseline = (uncovered: CoverageBaseline["uncovered"] = [], exempt: CoverageBaseline["exempt"] = []): CoverageBaseline => ({ avouchCoverage: 1, uncovered, exempt });
const match = (id: string, action: string, row: Row | undefined, result: string): ReconcileRow =>
  row === undefined ? { id, action, status: "match", result: { result } } : { id, action, status: "match", result: { result }, row };
const cannot = (id: string, reason: string, detail?: string, action = "RETURN") =>
  ({ id, action, status: "cannot_reconcile", reason, ...(detail !== undefined ? { detail } : {}) }) as ReconcileRow;

const BORROW: Row[] = [0, 1, 2, 3, "otherwise"];
const RETURN: Row[] = [0, 1, "otherwise"];
const borrowDebts = (ont: unknown = library) => BORROW.map((r) => debt("BORROW", r, ont));
// One match for each RETURN unit.
const returnVerified = (): ReconcileRow[] => [match("r0", "RETURN", 0, "REJECTED"), match("r1", "RETURN", 1, "RETURNED_LATE"), match("r2", "RETURN", "otherwise", "RETURNED")];

const patched = (ops: Op[]) => applyPatch(library, ops) as Stage1Ontology;
// A RETURN case on one ACTIVE Loan that is not late; the runtime and the scenario both state `result`.
const LOAN = { id: "LN-1", branch_id: "BR-1", state: "ACTIVE", due_date: "2026-01-15", return_condition: null };
const returnCase = (ont: Stage1Ontology, id: string, keys: string[], result: string, bindings: Record<string, Value> = { loan_id: "LN-1" }): RuntimeCase => ({
  id,
  action: "RETURN",
  snapshot: projectSnapshot(ont, { branches: [{ id: "BR-1", timezone: "UTC" }], loans: [{ ...LOAN }], people: [], members: [], books: [] }, (raw) => raw as Value).snapshot,
  inputs: { bindings, actor: { id: "P-1", kind: "person", keys }, scope: "BR-1", now: Date.UTC(2026, 0, 10) },
  reported: { result },
  expected: { result },
});
// RETURN with loan_active declared without an expression: a gap in rows.0, so all RETURN units are blocked.
const unspecified = (ids: Record<string, string[]>) => {
  const ont = structuredClone(library);
  for (const [action, conds] of Object.entries(ids)) {
    const a = ont.actionTypes[action]!;
    a.conditions = a.conditions.map((c) => (conds.includes(c.id) ? { id: c.id, unspecified: "x" } : c));
  }
  return ont;
};
const gapOnt = () => unspecified({ RETURN: ["loan_active"] });
const gap = (action: string, condition: string) => ({ action, condition, kind: "unspecified" as const });

describe("verifyCoverage: units", () => {
  it("without rows or baseline, every unit is uncovered, in unit order, with its when and result", () => {
    const r = verifyCoverage(library, [], null);
    expect(r.units).toBe(8);
    expect(r.uncovered).toEqual([...BORROW.map((x) => debt("BORROW", x)), ...RETURN.map((x) => debt("RETURN", x))]);
    expect(r.uncovered[0]).toEqual({ action: "BORROW", row: 0, when: { fails: "borrower_is_caller" }, result: "REJECTED" });
    expect(r.uncovered[4]).toEqual({ action: "BORROW", row: "otherwise", when: null, result: "BORROWED" });
    expect(r.ok).toBe(false);
    expect(r.noTable).toEqual([]);
    expect(r.verified).toEqual([]);
    expect(r.unasserted).toEqual([]);
  });

  it("a match with a row verifies its unit; a mismatch does not and fails", () => {
    const mismatch: ReconcileRow = { id: "m", action: "RETURN", status: "mismatch", evaluator: { result: "REJECTED" }, reported: { result: "RETURNED" }, expected: { result: "REJECTED" }, row: 0 };
    const r = verifyCoverage(library, [match("v", "RETURN", 1, "RETURNED_LATE"), mismatch], null);
    expect(r.verified).toEqual([unit("RETURN", 1)]);
    expect(r.uncovered.map((u) => `${u.action}:${u.row}`)).toContain("RETURN:0");
    expect(r.failed).toEqual([{ id: "m", action: "RETURN", why: "mismatch" }]);
  });

  it("a match without a row (an invocation result) verifies nothing and does not fail", () => {
    const r = verifyCoverage(library, [match("p", "RETURN", undefined, "PERMISSION_DENIED")], null);
    expect(r.verified).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("only the defect reasons of cannot_reconcile fail", () => {
    const reasons = ["envelope", "runtime_missing", "expectation_missing", "snapshot_missing", "evaluator_error", "runtime_unmapped", "indeterminate", "expectation_unmapped"];
    const rows = reasons.map((reason, i) => cannot(`c${i}`, reason, reason === "indeterminate" ? "unspecified" : undefined));
    const r = verifyCoverage(library, rows, null);
    expect(r.failed).toEqual(
      reasons.flatMap((why, i) => (["runtime_missing", "runtime_unmapped", "expectation_unmapped", "snapshot_missing", "evaluator_error"].includes(why) ? [{ id: `c${i}`, action: "RETURN", why }] : [])),
    );
    expect(r.failed).toHaveLength(5);
  });

  it("indeterminate with no_row_matched fails; indeterminate with another detail does not", () => {
    const r = verifyCoverage(library, [cannot("a", "indeterminate", "no_row_matched"), cannot("b", "indeterminate", "unspecified"), cannot("c", "runtime_unmapped", "X")], null);
    expect(r.failed).toEqual([
      { id: "a", action: "RETURN", why: "no_row_matched" },
      { id: "c", action: "RETURN", why: "runtime_unmapped" },
    ]);
  });

  it("indeterminate fails unless its detail is unspecified or permission_unknown; another or no detail fails as indeterminate", () => {
    const details = ["no_row_matched", "no_decision_table", "permission_condition", "unspecified", "permission_unknown", "other", undefined];
    const r = verifyCoverage(library, details.map((d, i) => cannot(`i${i}`, "indeterminate", d)), null);
    expect(r.failed).toEqual([
      { id: "i0", action: "RETURN", why: "no_row_matched" },
      { id: "i1", action: "RETURN", why: "no_decision_table" },
      { id: "i2", action: "RETURN", why: "permission_condition" },
      { id: "i5", action: "RETURN", why: "indeterminate" },
      { id: "i6", action: "RETURN", why: "indeterminate" },
    ]);
    expect(r.unasserted).toEqual([]);
  });

  it("a case that decide leaves undecided at the permission step fails, also when another case verifies the unit", () => {
    const ont = structuredClone(library);
    ont.actionTypes.RETURN.permission = { keys: ["loan:close"], conditional_keys: ["loan:inspect"] };
    const rows = reconcile(ont, [returnCase(ont, "c1", ["loan:close", "loan:inspect"], "RETURNED"), returnCase(ont, "c2", ["loan:close"], "PERMISSION_DENIED")]);
    expect(rows[1]).toEqual({ id: "c2", action: "RETURN", status: "cannot_reconcile", reason: "indeterminate", detail: "permission_condition" });
    const r = verifyCoverage(ont, rows, baseline([...borrowDebts(ont), debt("RETURN", 0, ont), debt("RETURN", 1, ont)]));
    expect(r.verified).toEqual([unit("RETURN", "otherwise")]);
    expect(r.failed).toEqual([{ id: "c2", action: "RETURN", why: "permission_condition" }]);
    expect(r.ok).toBe(false);
    // With a conditional_when that decides the case, decide gives PERMISSION_DENIED and the gate passes.
    ont.actionTypes.RETURN.parameters = { ...ont.actionTypes.RETURN.parameters, inspector: { type: "id", optional: true } };
    ont.actionTypes.RETURN.permission = { keys: ["loan:close"], conditional_keys: ["loan:inspect"], conditional_when: { isNotNull: [{ ref: "inspector" }] } };
    const decided = reconcile(ont, [returnCase(ont, "c1", ["loan:close", "loan:inspect"], "RETURNED"), returnCase(ont, "c2", ["loan:close"], "PERMISSION_DENIED", { loan_id: "LN-1", inspector: "P-2" })]);
    expect(decided[1]).toEqual({ id: "c2", action: "RETURN", status: "match", result: { result: "PERMISSION_DENIED" } });
    expect(verifyCoverage(ont, decided, baseline([...borrowDebts(ont), debt("RETURN", 0, ont), debt("RETURN", 1, ont)])).ok).toBe(true);
  });

  it("an action without a decision table has no units and is reported in noTable", () => {
    const ont = patched([{ op: "remove", path: "/actionTypes/RETURN/decision" }]);
    const r = verifyCoverage(ont, [], null);
    expect(r.noTable).toEqual(["RETURN"]);
    expect(r.units).toBe(5);
    expect(r.ok).toBe(false);
    expect(verifyCoverage(ont, [], baseline(borrowDebts(ont))).ok).toBe(true);
  });

  it("a match on a row that the action does not have, or with another result than its row, is row_unknown", () => {
    const r = verifyCoverage(library, [match("a", "RETURN", 9, "RETURNED"), match("b", "RETURN", 1, "RETURNED")], null);
    expect(r.failed).toEqual([
      { id: "a", action: "RETURN", why: "row_unknown" },
      { id: "b", action: "RETURN", why: "row_unknown" },
    ]);
    expect(r.verified).toEqual([]);
  });

  it("any row of an undeclared action is action_unknown, whatever its status", () => {
    const rows = [cannot("a", "expectation_missing", undefined, "NOPE"), cannot("b", "envelope", undefined, "NOPE"), match("c", "NOPE", 0, "REJECTED")];
    const r = verifyCoverage(library, rows, baseline([...borrowDebts(), ...RETURN.map((x) => debt("RETURN", x))]));
    expect(r.failed).toEqual([
      { id: "a", action: "NOPE", why: "action_unknown" },
      { id: "b", action: "NOPE", why: "action_unknown" },
      { id: "c", action: "NOPE", why: "action_unknown" },
    ]);
    expect(r.unasserted).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("a case without an expectation is unasserted: it verifies nothing and does not change ok", () => {
    const base = baseline([...borrowDebts(), debt("RETURN", 0)]);
    const rows = [match("r1", "RETURN", 1, "RETURNED_LATE"), match("r2", "RETURN", "otherwise", "RETURNED")];
    const without = verifyCoverage(library, rows, base);
    const r = verifyCoverage(library, [cannot("u1", "expectation_missing"), ...rows, cannot("u2", "expectation_missing")], base);
    expect(r.unasserted).toEqual([
      { id: "u1", action: "RETURN" },
      { id: "u2", action: "RETURN" },
    ]);
    expect(r.ok).toBe(without.ok);
    expect(r.ok).toBe(true);
    expect(r.baselined).toContainEqual(unit("RETURN", 0));
    expect(verifyCoverage(library, [cannot("u1", "expectation_missing")], null).uncovered).toContainEqual(debt("RETURN", 0));
  });
});

describe("verifyCoverage: baseline of uncovered units", () => {
  it("listed units are baselined, and the gate passes", () => {
    const r = verifyCoverage(library, returnVerified(), baseline(borrowDebts()));
    expect(r.ok).toBe(true);
    expect(r.baselined).toEqual(BORROW.map((x) => unit("BORROW", x)));
    expect(r.verified).toEqual(RETURN.map((x) => unit("RETURN", x)));
    expect(r.uncovered).toEqual([]);
  });

  it("an entry for a verified unit is stale", () => {
    const r = verifyCoverage(library, returnVerified(), baseline([...borrowDebts(), debt("RETURN", "otherwise")]));
    expect(r.stale).toEqual([{ list: "uncovered", action: "RETURN", row: "otherwise", why: "verified" }]);
    expect(r.ok).toBe(false);
  });

  it("an entry for a row that does not exist is stale no_such_row; a repeated entry is stale duplicate", () => {
    const noOtherwise = patched([{ op: "remove", path: "/actionTypes/RETURN/decision/otherwise" }]);
    const entries = [
      { action: "RETURN", row: 5, when: null, result: "RETURNED" },
      { action: "NOPE", row: 0, when: null, result: "RETURNED" },
      { action: "RETURN", row: "otherwise" as const, when: null, result: "RETURNED" },
      debt("RETURN", 0),
      debt("RETURN", 0),
    ];
    expect(verifyCoverage(noOtherwise, [], baseline(entries)).stale).toEqual([
      { list: "uncovered", action: "RETURN", row: 5, why: "no_such_row" },
      { list: "uncovered", action: "NOPE", row: 0, why: "no_such_row" },
      { list: "uncovered", action: "RETURN", row: "otherwise", why: "no_such_row" },
      { list: "uncovered", action: "RETURN", row: 0, why: "duplicate" },
    ]);
  });

  it("an entry whose row has another when or result is stale moved", () => {
    const entry = debt("RETURN", 0);
    expect(entry).toEqual({ action: "RETURN", row: 0, when: { fails: "loan_active" }, result: "REJECTED" });
    const moved = [{ list: "uncovered", action: "RETURN", row: 0, why: "moved" }];
    const removed = patched([{ op: "remove", path: "/actionTypes/RETURN/decision/rows/0" }]);
    expect(verifyCoverage(removed, [], baseline([entry])).stale).toEqual(moved);
    const rows = library.actionTypes.RETURN!.decision!.rows;
    const swapped = patched([
      { op: "replace", path: "/actionTypes/RETURN/decision/rows/0", value: rows[1] },
      { op: "replace", path: "/actionTypes/RETURN/decision/rows/1", value: rows[0] },
    ]);
    expect(verifyCoverage(swapped, [], baseline([entry])).stale).toEqual(moved);
    const inserted = patched([{ op: "add", path: "/actionTypes/RETURN/decision/rows/0", value: { when: { passes: "returned_late" }, result: "REJECTED" } }]);
    expect(verifyCoverage(inserted, [], baseline([entry])).stale).toEqual(moved);
    expect(verifyCoverage(removed, [], baseline([debt("RETURN", 1)])).stale).toEqual([{ list: "uncovered", action: "RETURN", row: 1, why: "no_such_row" }]);
  });

  it("an entry whose row has only another result is stale moved", () => {
    const entry = debt("RETURN", 0);
    const changed = patched([{ op: "replace", path: "/actionTypes/RETURN/decision/rows/0/result", value: "RETURNED" }]);
    expect(verifyCoverage(changed, [], baseline([entry])).stale).toEqual([{ list: "uncovered", action: "RETURN", row: 0, why: "moved" }]);
  });

  it("an entry for a blocked unit is stale blocked", () => {
    const ont = gapOnt();
    const r = verifyCoverage(ont, [], baseline([debt("RETURN", 1, ont)], [{ ...gap("RETURN", "loan_active"), reason: "x" }]));
    expect(r.stale).toEqual([{ list: "uncovered", action: "RETURN", row: 1, why: "blocked" }]);
  });
});

describe("verifyCoverage: gaps and exemptions", () => {
  it("a condition without an expression blocks its row and every later unit", () => {
    const r = verifyCoverage(gapOnt(), [], null);
    expect(r.blocked).toEqual(RETURN.map((x) => ({ ...unit("RETURN", x), condition: "loan_active" })));
    expect(r.uncovered.map((u) => u.action)).toEqual(["BORROW", "BORROW", "BORROW", "BORROW", "BORROW"]);
    expect(r.unexempted).toEqual([gap("RETURN", "loan_active")]);
  });

  it("an exemption with a reason accepts the gap", () => {
    const ont = gapOnt();
    const r = verifyCoverage(ont, [], baseline(borrowDebts(ont), [{ ...gap("RETURN", "loan_active"), reason: "x" }]));
    expect(r.ok).toBe(true);
    expect(r.blocked).toHaveLength(3);
    expect(r.unexempted).toEqual([]);
  });

  it("an exemption without a reason, or with only white space, is unreasoned", () => {
    const ont = gapOnt();
    for (const reason of ["", "  ", undefined]) {
      const exempt = reason === undefined ? gap("RETURN", "loan_active") : { ...gap("RETURN", "loan_active"), reason };
      const r = verifyCoverage(ont, [], baseline(borrowDebts(ont), [exempt]));
      expect(r.unreasoned, String(reason)).toEqual([gap("RETURN", "loan_active")]);
      expect(r.unexempted).toEqual([]);
      expect(r.ok).toBe(false);
    }
  });

  it("an exemption of a condition that is not a gap is stale not_a_gap; a repeated one is stale duplicate", () => {
    const ont = gapOnt();
    const exempt = [
      { ...gap("RETURN", "returned_late"), reason: "x" },
      { ...gap("RETURN", "nope"), reason: "x" },
      { ...gap("RETURN", "loan_active"), reason: "x" },
      { ...gap("RETURN", "loan_active"), reason: "y" },
    ];
    expect(verifyCoverage(ont, [], baseline([], exempt)).stale).toEqual([
      { list: "exempt", action: "RETURN", condition: "returned_late", why: "not_a_gap" },
      { list: "exempt", action: "RETURN", condition: "nope", why: "not_a_gap" },
      { list: "exempt", action: "RETURN", condition: "loan_active", why: "duplicate" },
    ]);
  });

  it("a condition with an expression that reads a derived property without one is not a gap", () => {
    const ont = patched([{ op: "replace", path: "/actionTypes/RETURN/conditions/0/expr", value: { derived: { id: "loan_overdue", of: { ref: "loan_id" } } } }]);
    // the query flags it as not specified, but it has an expression, so it is an ordinary unit
    expect(queryAction(ont, "RETURN")!.decision!.rows[0].requires).toEqual([{ condition: "loan_active", must: "fail", specified: false }]);
    const r = verifyCoverage(ont, [], baseline([], [{ ...gap("RETURN", "loan_active"), reason: "x" }]));
    expect(r.blocked).toEqual([]);
    expect(r.unexempted).toEqual([]);
    expect(r.uncovered.filter((u) => u.action === "RETURN").map((u) => u.row)).toEqual(RETURN);
    expect(r.stale).toEqual([{ list: "exempt", action: "RETURN", condition: "loan_active", why: "not_a_gap" }]);
  });
});

describe("verifyCoverage: shape checks", () => {
  const throwsWith = (rows: unknown, base: unknown, prefix: string) =>
    expect(() => verifyCoverage(library, rows as ReconcileRow[], base as CoverageBaseline)).toThrow(new RegExp(`^${prefix.replace(/[[\]().]/g, "\\$&")}`));

  it("rejects an ontology without an actionTypes object", () => {
    for (const ont of [{ foo: 1 }, { actionTypes: [] }, null]) expect(() => verifyCoverage(ont, [], null)).toThrow("ontology: actionTypes is not an object");
  });

  it("quotes a string in a message, so that it is not taken for a number", () => {
    throwsWith([{ id: "a", action: "RETURN", status: "match", result: { result: "RETURNED" }, row: "0" }], null, 'rows[0]: row "0" is not');
  });

  it("rejects a reconcile row with a wrong shape", () => {
    throwsWith([{ id: "a", action: "RETURN", status: "ok" }], null, "rows[0]: status");
    throwsWith([{ id: "a", action: "RETURN", status: "match", result: { result: "RETURNED" }, row: -1 }], null, "rows[0]: row");
    throwsWith([{ id: "a", action: "RETURN", status: "cannot_reconcile", reason: "nope" }], null, "rows[0]: reason");
  });

  it("rejects a baseline with a wrong shape", () => {
    throwsWith([], { avouchCoverage: 2, uncovered: [], exempt: [] }, "baseline: avouchCoverage");
    throwsWith([], { avouchCoverage: 1, uncovered: [] }, "baseline: exempt");
    throwsWith([], { avouchCoverage: 1, uncovered: [], exempt: [], extra: 1 }, "baseline: extra");
    throwsWith([], { avouchCoverage: 1, uncovered: [], exempt: [{ action: "RETURN", condition: "loan_active", kind: "knownSourceGap" }] }, "baseline: exempt[0].kind");
    throwsWith([], { avouchCoverage: 1, uncovered: [{ action: "RETURN", row: "x", when: null, result: "RETURNED" }], exempt: [] }, "baseline: uncovered[0].row");
    throwsWith([], { avouchCoverage: 1, uncovered: [{ action: "RETURN", row: 0 }], exempt: [] }, "baseline: uncovered[0]");
  });
});

describe("verifyCoverage: order and purity", () => {
  it("output lists keep unit and gap order; stale keeps baseline order", () => {
    const ont = unspecified({ BORROW: ["book_available"], RETURN: ["loan_active", "returned_late"] });
    const r = verifyCoverage(
      ont,
      [],
      baseline(
        [{ action: "BORROW", row: 9, when: null, result: "REJECTED" }, debt("BORROW", 0, ont), debt("BORROW", 2, ont)],
        [gap("RETURN", "returned_late"), { ...gap("RETURN", "nope"), reason: "x" }, gap("BORROW", "book_available")],
      ),
    );
    expect(r.baselined).toEqual([unit("BORROW", 0)]);
    expect(r.blocked).toEqual([
      ...[1, 2, 3, "otherwise"].map((x) => ({ action: "BORROW", row: x, condition: "book_available" })),
      ...RETURN.map((x) => ({ action: "RETURN", row: x, condition: "loan_active" })),
    ]);
    expect(r.unreasoned).toEqual([gap("BORROW", "book_available"), gap("RETURN", "returned_late")]);
    expect(r.unexempted).toEqual([gap("RETURN", "loan_active")]);
    expect(r.stale).toEqual([
      { list: "exempt", action: "RETURN", condition: "nope", why: "not_a_gap" },
      { list: "uncovered", action: "BORROW", row: 9, why: "no_such_row" },
      { list: "uncovered", action: "BORROW", row: 2, why: "blocked" },
    ]);
    const shuffled = verifyCoverage(library, [], baseline([debt("RETURN", 1), debt("BORROW", 3), debt("BORROW", 0)]));
    expect(shuffled.baselined).toEqual([unit("BORROW", 0), unit("BORROW", 3), unit("RETURN", 1)]);
    expect(shuffled.uncovered.map((u) => `${u.action}:${u.row}`)).toEqual(["BORROW:1", "BORROW:2", "BORROW:otherwise", "RETURN:0", "RETURN:otherwise"]);
  });

  it("is pure: the same input gives the same result, and the input is not changed", () => {
    const ont = gapOnt();
    const rows = [...returnVerified(), cannot("x", "runtime_missing")];
    const base = baseline(borrowDebts(ont), [{ ...gap("RETURN", "loan_active"), reason: "x" }]);
    const before = structuredClone({ ont, rows, base });
    expect(verifyCoverage(ont, rows, base)).toEqual(verifyCoverage(ont, rows, base));
    expect({ ont, rows, base }).toEqual(before);
  });
});
