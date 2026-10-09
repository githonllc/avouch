// Runtime consistency (src/reconcile.ts): decide(snapshot before the call, inputs) = runtime result = scenario expectation.
// Results that cannot be compared are reported as such and are never filled in from the decision table.
// Toy library only: RETURN on Loan, Branch as the scope root.
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import type { Value } from "../src/evaluate";
import type { Stage1Ontology, Type } from "../src/expr";
import { projectSnapshot, reconcile, type Decode, type Reported, type RuntimeCase } from "../src/reconcile";

const library = parse(ontologyText) as Stage1Ontology;
const identity: Decode = (raw) => raw as Value;

const LOAN = { id: "LN-1", branch_id: "BR-1", state: "ACTIVE", due_date: "2026-01-15", return_condition: null };
const baseStores = () => ({ branches: [{ id: "BR-1", timezone: "UTC" }], loans: [{ ...LOAN }], people: [], members: [], books: [] });
const RETURNED: Reported = { result: "RETURNED" };

// The baseline case; each test overrides only the fields it names. Built inside each test (the snapshot comes from projectSnapshot).
function baseCase(over: Partial<RuntimeCase> = {}, ont: Stage1Ontology = library, stores = baseStores()): RuntimeCase {
  return {
    id: "inv-1",
    action: "RETURN",
    snapshot: projectSnapshot(ont, stores, identity).snapshot,
    inputs: { bindings: { loan_id: "LN-1" }, actor: { id: "P-1", kind: "person", keys: ["loan:close"] }, scope: "BR-1", now: Date.UTC(2026, 0, 10) },
    reported: RETURNED,
    expected: RETURNED,
    ...over,
  };
}
const one = (c: RuntimeCase, ont: Stage1Ontology = library) => {
  const rows = reconcile(ont, [c]);
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe("reconcile: three-way equality", () => {
  it("evaluator, runtime and scenario agree -> match", () => {
    expect(one(baseCase())).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "RETURNED" } });
  });

  it("the runtime differs from the evaluator -> mismatch, all three results shown", () => {
    expect(one(baseCase({ reported: { result: "RETURNED_LATE" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "mismatch",
      evaluator: { result: "RETURNED" },
      reported: { result: "RETURNED_LATE" },
      expected: { result: "RETURNED" },
    });
  });

  it("the scenario differs while evaluator and runtime agree -> mismatch", () => {
    expect(one(baseCase({ expected: { result: "REJECTED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "mismatch",
      evaluator: { result: "RETURNED" },
      reported: { result: "RETURNED" },
      expected: { result: "REJECTED" },
    });
  });

  it("an invocation-layer result is compared too: a missing key gives PERMISSION_DENIED", () => {
    const c = baseCase({ reported: { result: "PERMISSION_DENIED" }, expected: { result: "PERMISSION_DENIED" } });
    c.inputs = { ...c.inputs, actor: { ...c.inputs.actor, keys: [] } };
    expect(one(c)).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "PERMISSION_DENIED" } });
  });

  it("an id outside the scope is compared after the outward projection: not_found, without param", () => {
    const stores = baseStores();
    stores.loans.push({ id: "LN-9", branch_id: "BR-2", state: "ACTIVE", due_date: "2026-01-15", return_condition: null });
    const notFound: Reported = { result: "INVALID_BINDING", reason: "not_found" };
    const c = baseCase({ reported: notFound, expected: notFound }, library, stores);
    c.inputs = { ...c.inputs, bindings: { loan_id: "LN-9" } };
    expect(one(c)).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "INVALID_BINDING", reason: "not_found" } });
  });

  it("the INVALID_BINDING reason is part of equality", () => {
    const notFound: Reported = { result: "INVALID_BINDING", reason: "not_found" };
    const c = baseCase({ reported: notFound, expected: notFound });
    c.inputs = { ...c.inputs, bindings: { loan_id: "LN-1", x: "1" } };
    expect(one(c)).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "mismatch",
      evaluator: { result: "INVALID_BINDING", reason: "unknown_param" },
      reported: notFound,
      expected: notFound,
    });
  });
});

describe("reconcile: an absent reason", () => {
  it("a reason present as undefined equals an absent reason", () => {
    expect(one(baseCase({ reported: { result: "RETURNED", reason: undefined }, expected: { result: "RETURNED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "match",
      result: { result: "RETURNED" },
    });
  });
});

describe("reconcile: results that cannot be reconciled", () => {
  it("an envelope result is never reconciled, even without a snapshot", () => {
    for (const result of ["REPLAYED", "IDEMPOTENCY_CONFLICT"])
      expect(one(baseCase({ reported: { result }, snapshot: null }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "envelope" });
  });

  it("the envelope check comes before the expectation and snapshot checks", () => {
    const envelope = { id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "envelope" };
    expect(one(baseCase({ reported: { result: "REPLAYED" }, expected: null }))).toEqual(envelope);
    expect(one(baseCase({ reported: { result: "REPLAYED" }, expected: null, snapshot: null }))).toEqual(envelope);
  });

  it("an envelope result is not reconciled even when the action is unknown to the evaluator", () => {
    expect(one(baseCase({ action: "NOPE", reported: { result: "REPLAYED" } }))).toMatchObject({ status: "cannot_reconcile", reason: "envelope" });
  });

  it("a missing runtime result is not filled in from the decision table", () => {
    expect(one(baseCase({ reported: null }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_missing" });
  });

  it("a missing scenario expectation is not filled in either", () => {
    expect(one(baseCase({ expected: null }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_missing" });
  });

  it("a missing snapshot cannot be evaluated", () => {
    expect(one(baseCase({ snapshot: null }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "snapshot_missing" });
  });

  it("the checks run in order: runtime, then expectation, then snapshot", () => {
    expect(one(baseCase({ reported: null, expected: null, snapshot: null }))).toMatchObject({ reason: "runtime_missing" });
    expect(one(baseCase({ expected: null, snapshot: null }))).toMatchObject({ reason: "expectation_missing" });
  });

  it("an evaluator error is reported with its message", () => {
    const row = one(baseCase({ action: "NOPE" }));
    expect(row).toMatchObject({ id: "inv-1", action: "NOPE", status: "cannot_reconcile", reason: "evaluator_error" });
    expect(row.status === "cannot_reconcile" && row.detail).toContain("unknown action");
  });

  it("a reported result that the action cannot give is unmapped; the detail is that result", () => {
    expect(one(baseCase({ reported: { result: "NOPE_RESULT" }, expected: { result: "RETURNED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "cannot_reconcile",
      reason: "runtime_unmapped",
      detail: "NOPE_RESULT",
    });
  });

  it("a result that only another action gives is unmapped", () => {
    expect(one(baseCase({ reported: { result: "BORROWED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "cannot_reconcile",
      reason: "runtime_unmapped",
      detail: "BORROWED",
    });
  });

  it("without a decision table every domain result is unmapped, before INDETERMINATE", () => {
    const ont = structuredClone(library);
    delete ont.actionTypes.RETURN!.decision;
    expect(one(baseCase({}, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "RETURNED" });
  });

  it("an invocation result is never unmapped, even without a decision table", () => {
    const ont = structuredClone(library);
    delete ont.actionTypes.RETURN!.decision;
    const c = baseCase({ reported: { result: "PERMISSION_DENIED" }, expected: { result: "PERMISSION_DENIED" } }, ont);
    c.inputs = { ...c.inputs, actor: { ...c.inputs.actor, keys: [] } };
    expect(one(c, ont)).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "PERMISSION_DENIED" } });
  });

  it("INDETERMINATE is not reconciled; the detail is its reason", () => {
    const ont = structuredClone(library);
    const ret = ont.actionTypes.RETURN!;
    ret.conditions = ret.conditions.map((c) => (c.id === "loan_active" ? { id: "loan_active", unspecified: "x" } : c));
    expect(one(baseCase({}, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "indeterminate", detail: "unspecified" });
  });

  it("returns one row per case, in input order", () => {
    const rows = reconcile(library, [baseCase({ id: "a", reported: null }), baseCase({ id: "b" }), baseCase({ id: "c", reported: { result: "REPLAYED" } })]);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["a", "cannot_reconcile"],
      ["b", "match"],
      ["c", "cannot_reconcile"],
    ]);
  });
});

describe("projectSnapshot: physical type mapping", () => {
  const thing = (linkTypes: Stage1Ontology["linkTypes"] = []): Stage1Ontology => ({
    objectTypes: { Thing: { datasource: "things", properties: { flag: { type: "boolean" }, n: { type: "integer" }, label: {} } } },
    linkTypes,
    actionTypes: {},
  });
  const bool01 = (raw: unknown, type: Type): Value | undefined => (type === "boolean" ? ({ 0: false, 1: true } as Record<string, boolean>)[String(raw)] : (raw as Value));

  it("decodes declared columns and copies the others as they are", () => {
    const decode = vi.fn(bool01);
    const out = projectSnapshot(thing(), { things: [{ id: "t1", flag: 1, n: 2, label: "x", extra: "k" }] }, decode);
    expect(out).toEqual({ snapshot: { objects: { Thing: [{ id: "t1", flag: true, n: 2, label: "x", extra: "k" }] } }, defects: [] });
    expect("links" in out.snapshot).toBe(false);
    // Only the typed columns flag and n are decoded; the untyped label and the undeclared extra are not.
    expect(decode.mock.calls.map(([raw]) => raw)).toEqual([1, 2]);
  });

  it("a value that cannot be decoded is a defect and keeps its raw value", () => {
    const out = projectSnapshot(thing(), { things: [{ id: "t1", flag: 2, n: 2 }] }, bool01);
    expect(out.defects).toEqual([{ object: "Thing", prop: "flag", row: "t1", value: 2 }]);
    expect(out.snapshot.objects.Thing).toEqual([{ id: "t1", flag: 2, n: 2 }]);
  });

  it("a decoded value that does not fit the type is a defect", () => {
    const decode: Decode = (raw, type) => (type === "integer" ? 1.5 : bool01(raw, type));
    const out = projectSnapshot(thing(), { things: [{ id: "t1", flag: 1, n: 2 }] }, decode);
    expect(out.defects).toEqual([{ object: "Thing", prop: "n", row: "t1", value: 2 }]);
    expect(out.snapshot.objects.Thing).toEqual([{ id: "t1", flag: true, n: 2 }]);
  });

  it("null stays null and is never passed to decode", () => {
    const decode = vi.fn(bool01);
    const out = projectSnapshot(thing(), { things: [{ id: "t1", flag: null, n: 2 }] }, decode);
    expect(out).toEqual({ snapshot: { objects: { Thing: [{ id: "t1", flag: null, n: 2 }] } }, defects: [] });
    expect(decode.mock.calls.some(([raw]) => raw === null)).toBe(false);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("an absent column is not projected and is not a defect", () => {
    const out = projectSnapshot(thing(), { things: [{ id: "t1", flag: 0 }] }, bool01);
    expect(out).toStrictEqual({ snapshot: { objects: { Thing: [{ id: "t1", flag: false }] } }, defects: [] });
    expect("n" in out.snapshot.objects.Thing![0]!).toBe(false);
  });

  it("a missing store throws", () => {
    expect(() => projectSnapshot(thing(), {}, bool01)).toThrow("snapshot lacks store things");
  });

  it("a pure link table is not projected: it throws", () => {
    const ont = thing([{ id: "thing_tag", from: "Thing", to: "Thing", via: "tag_id", table: "thing_tags" }]);
    expect(() => projectSnapshot(ont, { things: [], thing_tags: [] }, bool01)).toThrow("pure link thing_tag is not projected");
  });

  it("a link whose table is an object datasource is not a pure link", () => {
    const ont = thing([{ id: "thing_self", from: "Thing", to: "Thing", via: "parent_id", table: "things" }]);
    expect(projectSnapshot(ont, { things: [] }, bool01).defects).toEqual([]);
  });

  it("the toy library projects with the identity decode and no defects", () => {
    const out = projectSnapshot(library, baseStores(), identity);
    expect(out.defects).toEqual([]);
    expect(Object.keys(out.snapshot.objects)).toEqual(Object.keys(library.objectTypes));
    expect(out.snapshot.objects.Loan).toEqual([LOAN]);
  });
});
