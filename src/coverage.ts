// Decision-row coverage of reconcile rows (`avouch gate verify`). A rule of the tool, not of the format. A pure function:
// it reads only its arguments, and the order of each output list is fixed.
import { isObj } from "./expr.js";
import { queryAction, type QueryRow } from "./query.js";
import type { CannotReconcile, ReconcileRow } from "./reconcile.js";

/** One coverage unit: a row of a decision table (index from 0) or its otherwise. Key text: `<action>:rows.<i>` / `<action>:otherwise`. */
export type CoverageUnit = { action: string; row: number | "otherwise" };
/** A unit with the `when` and `result` of its row, so that an entry for a row that moved is stale. */
export type CoverageDebt = CoverageUnit & { when: { passes: string } | { fails: string } | null; result: string };
/** A condition that a decision row names and that is declared without an expression. */
export type CoverageGap = { action: string; condition: string; kind: "unspecified" };
export type CoverageExemption = CoverageGap & { reason?: string };
export type CoverageBaseline = { avouchCoverage: 1; uncovered: CoverageDebt[]; exempt: CoverageExemption[] };
export type CoverageStale =
  | { list: "uncovered"; action: string; row: number | "otherwise"; why: "duplicate" | "no_such_row" | "moved" | "verified" | "blocked" }
  | { list: "exempt"; action: string; condition: string; why: "duplicate" | "not_a_gap" };
export type CoverageFailure = {
  id: string;
  action: string;
  why: "mismatch" | "action_unknown" | "row_unknown" | "no_row_matched" | "runtime_missing" | "runtime_unmapped" | "expectation_unmapped" | "snapshot_missing" | "evaluator_error";
};
export interface CoverageResult {
  ok: boolean; // true iff the five failure lists below are all empty
  units: number; // count of units over all actions with a decision table
  verified: CoverageUnit[]; // info: a match row with this action and row
  baselined: CoverageUnit[]; // info: not verified, not blocked, listed in baseline.uncovered
  blocked: (CoverageUnit & { condition: string })[]; // info: not verified, at or after a row that names a gap
  noTable: string[]; // info: actions without a decision table
  unasserted: { id: string; action: string }[]; // info: cases without an expectation (expectation_missing)
  uncovered: CoverageDebt[]; // FAIL
  unexempted: CoverageGap[]; // FAIL
  unreasoned: CoverageGap[]; // FAIL
  stale: CoverageStale[]; // FAIL
  failed: CoverageFailure[]; // FAIL
}

// Which reasons of cannot_reconcile fail the gate. A replay is not a decision; a case without an expectation states
// nothing to compare; INDETERMINATE does not fail (except no_row_matched: see below), and the units that it leaves
// unverified stay uncovered or blocked, so the gate still sees them.
const FAILS: Record<CannotReconcile, boolean> = {
  envelope: false,
  expectation_missing: false,
  indeterminate: false,
  runtime_missing: true,
  runtime_unmapped: true,
  expectation_unmapped: true,
  snapshot_missing: true,
  evaluator_error: true,
};

const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const show = (x: unknown) => JSON.stringify(x) ?? String(x);
const isRow = (x: unknown): x is number | "otherwise" => x === "otherwise" || (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);
const sameWhen = (a: CoverageDebt["when"], b: QueryRow["when"]) => JSON.stringify(a) === JSON.stringify(b);

function checkKeys(o: Record<string, unknown>, path: string, required: readonly string[], allowed: readonly string[]): void {
  for (const k of required) if (!Object.hasOwn(o, k)) throw new Error(`baseline: ${path}${k}: missing`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`baseline: ${path}${k}: unknown key`);
}

function checkRows(rows: unknown): asserts rows is readonly ReconcileRow[] {
  if (!Array.isArray(rows)) throw new Error("rows: not an array");
  rows.forEach((x: unknown, i) => {
    const at = `rows[${i}]:`;
    if (!isObj(x)) throw new Error(`${at} not an object`);
    if (typeof x.id !== "string") throw new Error(`${at} id is not a string`);
    if (typeof x.action !== "string") throw new Error(`${at} action is not a string`);
    if (x.status === "match" || x.status === "mismatch") {
      if (x.row !== undefined && !isRow(x.row)) throw new Error(`${at} row ${show(x.row)} is not a row index or "otherwise"`);
    } else if (x.status === "cannot_reconcile") {
      if (typeof x.reason !== "string" || !Object.hasOwn(FAILS, x.reason)) throw new Error(`${at} reason ${show(x.reason)} is not a reason of cannot_reconcile`);
    } else throw new Error(`${at} status ${show(x.status)} is not match, mismatch or cannot_reconcile`);
  });
}

function checkBaseline(b: unknown): asserts b is CoverageBaseline {
  if (!isObj(b)) throw new Error("baseline: not an object");
  checkKeys(b, "", ["avouchCoverage", "uncovered", "exempt"], ["avouchCoverage", "uncovered", "exempt"]);
  if (b.avouchCoverage !== 1) throw new Error(`baseline: avouchCoverage: ${show(b.avouchCoverage)} is not 1`);
  if (!Array.isArray(b.uncovered)) throw new Error("baseline: uncovered: not an array");
  if (!Array.isArray(b.exempt)) throw new Error("baseline: exempt: not an array");
  b.uncovered.forEach((x: unknown, i) => {
    const at = `uncovered[${i}]`;
    if (!isObj(x)) throw new Error(`baseline: ${at}: not an object`);
    checkKeys(x, `${at}.`, ["action", "row", "when", "result"], ["action", "row", "when", "result"]);
    if (typeof x.action !== "string") throw new Error(`baseline: ${at}.action: not a string`);
    if (!isRow(x.row)) throw new Error(`baseline: ${at}.row: ${show(x.row)} is not a row index or "otherwise"`);
    const w = x.when;
    const when = w === null || (isObj(w) && Object.keys(w).length === 1 && (typeof w.passes === "string" || typeof w.fails === "string"));
    if (!when) throw new Error(`baseline: ${at}.when: not null, {passes: <condition>} or {fails: <condition>}`);
    if (typeof x.result !== "string") throw new Error(`baseline: ${at}.result: not a string`);
  });
  b.exempt.forEach((x: unknown, i) => {
    const at = `exempt[${i}]`;
    if (!isObj(x)) throw new Error(`baseline: ${at}: not an object`);
    checkKeys(x, `${at}.`, ["action", "condition", "kind"], ["action", "condition", "kind", "reason"]);
    if (typeof x.action !== "string") throw new Error(`baseline: ${at}.action: not a string`);
    if (typeof x.condition !== "string") throw new Error(`baseline: ${at}.condition: not a string`);
    if (x.kind !== "unspecified") throw new Error(`baseline: ${at}.kind: ${show(x.kind)} is not supported by this version`);
    if (x.reason !== undefined && typeof x.reason !== "string") throw new Error(`baseline: ${at}.reason: not a string`);
  });
}

type Unit = { action: string; q: QueryRow; gap: string | null };

// Coverage of the decision rows of every action of the ontology by the match rows. baseline null = both lists empty.
// Throws for an ontology without an actionTypes object, or rows or a baseline with a wrong shape (the message starts
// with "ontology:", "rows" or "baseline:").
export function verifyCoverage(ont: unknown, rows: readonly ReconcileRow[], baseline: CoverageBaseline | null): CoverageResult {
  if (!isObj(ont) || !isObj(ont.actionTypes)) throw new Error("ontology: actionTypes is not an object");
  const actionTypes = ont.actionTypes;
  checkRows(rows);
  if (baseline !== null) checkBaseline(baseline);
  const base = baseline ?? { avouchCoverage: 1, uncovered: [], exempt: [] };

  // 1. Units and gaps. A gap: a condition that a row names (as its own or as an earlier row's) and that has no expression.
  const units: Unit[] = [];
  const unitOf = new Map<string, Unit>();
  const gaps: CoverageGap[] = [];
  const noTable: string[] = [];
  const key = (action: string, x: string | number) => JSON.stringify([action, x]);
  for (const action of Object.keys(actionTypes).sort(sortStr)) {
    const q = queryAction(ont, action);
    if (q === null) continue;
    if (q.decision === null) {
      noTable.push(action);
      continue;
    }
    const isGap = (c: string) => q.conditions.find((x) => x.id === c)?.expr === null;
    const named = new Set<string>();
    for (const r of q.decision.rows) {
      const u: Unit = { action, q: r, gap: r.requires.find((x) => isGap(x.condition))?.condition ?? null };
      units.push(u);
      unitOf.set(key(action, r.row), u);
      for (const x of r.requires) if (isGap(x.condition)) named.add(x.condition);
    }
    for (const condition of [...named].sort(sortStr)) gaps.push({ action, condition, kind: "unspecified" });
  }
  const gapKeys = new Set(gaps.map((g) => key(g.action, g.condition)));

  // 2. Case rows, in input order.
  const verified = new Set<Unit>();
  const failed: CoverageFailure[] = [];
  const unasserted: CoverageResult["unasserted"] = [];
  for (const r of rows) {
    const head = { id: r.id, action: r.action };
    if (!Object.hasOwn(actionTypes, r.action)) failed.push({ ...head, why: "action_unknown" });
    else if (r.status === "mismatch") failed.push({ ...head, why: "mismatch" });
    else if (r.status === "cannot_reconcile") {
      if (r.reason === "indeterminate" && r.detail === "no_row_matched") failed.push({ ...head, why: "no_row_matched" });
      else if (FAILS[r.reason]) failed.push({ ...head, why: r.reason as CoverageFailure["why"] });
      else if (r.reason === "expectation_missing") unasserted.push(head);
    } else if (r.row !== undefined) {
      // a match on a row: the unit must exist and give the same result
      const u = unitOf.get(key(r.action, r.row));
      const result = isObj(r.result) ? r.result.result : undefined;
      if (u === undefined || u.q.result !== result) failed.push({ ...head, why: "row_unknown" });
      else verified.add(u);
    }
  }

  // 3. Exemptions, in baseline order.
  const stale: CoverageStale[] = [];
  const exempted = new Set<string>();
  const unreasonedKeys = new Set<string>();
  const seenExempt = new Set<string>();
  for (const e of base.exempt) {
    const k = key(e.action, e.condition);
    const out = { list: "exempt" as const, action: e.action, condition: e.condition };
    if (seenExempt.has(k)) stale.push({ ...out, why: "duplicate" });
    else if (!gapKeys.has(k)) stale.push({ ...out, why: "not_a_gap" });
    else {
      exempted.add(k);
      if (e.reason === undefined || e.reason.trim() === "") unreasonedKeys.add(k);
    }
    seenExempt.add(k);
  }

  // 4. Uncovered entries, in baseline order. The baseline must have no dead entries.
  const owed = new Set<Unit>();
  const seenDebt = new Set<string>();
  for (const d of base.uncovered) {
    const k = key(d.action, d.row);
    const u = unitOf.get(k);
    const out = { list: "uncovered" as const, action: d.action, row: d.row };
    if (seenDebt.has(k)) stale.push({ ...out, why: "duplicate" });
    else if (u === undefined) stale.push({ ...out, why: "no_such_row" });
    else if (!sameWhen(d.when, u.q.when) || d.result !== u.q.result) stale.push({ ...out, why: "moved" });
    else if (verified.has(u)) stale.push({ ...out, why: "verified" });
    else if (u.gap !== null) stale.push({ ...out, why: "blocked" });
    else owed.add(u);
    seenDebt.add(k);
  }

  // 5. Each unit, in unit order.
  const result: CoverageResult = {
    ok: false,
    units: units.length,
    verified: [],
    baselined: [],
    blocked: [],
    noTable,
    unasserted,
    uncovered: [],
    unexempted: gaps.filter((g) => !exempted.has(key(g.action, g.condition))),
    unreasoned: gaps.filter((g) => unreasonedKeys.has(key(g.action, g.condition))),
    stale,
    failed,
  };
  for (const u of units) {
    const id = { action: u.action, row: u.q.row };
    if (verified.has(u)) result.verified.push(id);
    else if (u.gap !== null) result.blocked.push({ ...id, condition: u.gap });
    else if (owed.has(u)) result.baselined.push(id);
    else result.uncovered.push({ ...id, when: u.q.when, result: u.q.result as string });
  }
  result.ok = [result.uncovered, result.unexempted, result.unreasoned, result.stale, result.failed].every((x) => x.length === 0);
  return result;
}
