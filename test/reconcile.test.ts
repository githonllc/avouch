// Runtime consistency (src/reconcile.ts): decide(snapshot before the call, inputs) = runtime result = scenario expectation.
// Results that cannot be compared are reported as such and are never filled in from the decision table.
// Toy library only: RETURN on Loan, Branch as the scope root.
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import type { Value } from "../src/evaluate";
import type { Expr, Stage1Ontology, Type } from "../src/expr";
import { domainResults, projectSnapshot, reconcile, type Decode, type Reported, type RuntimeCase } from "../src/reconcile";

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
    expect(one(baseCase())).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "RETURNED" }, row: "otherwise" });
  });

  it("the runtime differs from the evaluator -> mismatch, all three results shown", () => {
    expect(one(baseCase({ reported: { result: "RETURNED_LATE" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "mismatch",
      evaluator: { result: "RETURNED" },
      reported: { result: "RETURNED_LATE" },
      expected: { result: "RETURNED" },
      row: "otherwise",
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
      row: "otherwise",
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

  it("a projected ref parameter that is null is compared as not_found", () => {
    const projected = structuredClone(library);
    projected.actionTypes.RETURN.parameters!.loan_id.projectedFrom = ["loan_ref"];
    const notFound: Reported = { result: "INVALID_BINDING", reason: "not_found" };
    const c = baseCase({ reported: notFound, expected: notFound }, projected);
    c.inputs = { ...c.inputs, bindings: { loan_id: null } };
    expect(one(c, projected)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "match", result: notFound });
    const plain = baseCase({ reported: notFound, expected: notFound });
    plain.inputs = { ...plain.inputs, bindings: { loan_id: null } };
    expect(one(plain)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "mismatch", evaluator: { result: "INVALID_BINDING", reason: "missing" }, reported: notFound, expected: notFound });
  });

  it("an optional projected ref parameter that is absent is missing: the projection did not run, a mismatch", () => {
    const projected = structuredClone(library);
    projected.actionTypes.RETURN.parameters!.loan_id.projectedFrom = ["loan_ref"];
    projected.actionTypes.RETURN.parameters!.loan_id.optional = true;
    const c = baseCase({}, projected);
    c.inputs = { ...c.inputs, bindings: {} };
    expect(one(c, projected)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "mismatch", evaluator: { result: "INVALID_BINDING", reason: "missing" }, reported: RETURNED, expected: RETURNED });
  });

  it("a ref with unresolved: domain: an absent id and an id of another branch match the domain result", () => {
    const soft = structuredClone(library);
    const ret = soft.actionTypes.RETURN;
    Object.assign(ret.parameters!.loan_id, { unresolved: "domain" });
    const cites = [{ cite: { doc: "L6", quote: "RETURN closes an ACTIVE Loan" } }];
    const loanFound = { id: "loan_found", expr: { isNotNull: [{ ref: "loan_id" }] } as Expr, cites };
    const notFound = { when: { fails: "loan_found" }, result: "REJECTED", cites };
    ret.conditions.unshift(loanFound);
    ret.decision!.rows.unshift(notFound);
    const stores = baseStores();
    stores.loans.push({ ...LOAN, id: "LN-2", branch_id: "BR-2" });
    const rejected: Reported = { result: "REJECTED" };
    for (const loan_id of ["LN-9", "LN-2"]) {
      const c = baseCase({ reported: rejected, expected: rejected }, soft, stores);
      c.inputs = { ...c.inputs, bindings: { loan_id } };
      expect(one(c, soft)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "match", result: rejected, row: 0 });
    }
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

  it("a match on a domain result carries the decision row", () => {
    const late: Reported = { result: "RETURNED_LATE" };
    const c = baseCase({ reported: late, expected: late });
    c.inputs = { ...c.inputs, now: Date.UTC(2026, 0, 20) };
    expect(one(c)).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: late, row: 1 });
  });

  it("a row for an invocation result has no row key", () => {
    const c = baseCase({ reported: { result: "PERMISSION_DENIED" }, expected: { result: "PERMISSION_DENIED" } });
    c.inputs = { ...c.inputs, actor: { ...c.inputs.actor, keys: [] } };
    expect(one(c)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "PERMISSION_DENIED" } });
  });

  it("a mismatch on a domain result carries the decision row", () => {
    const c = baseCase({ reported: { result: "RETURNED" }, expected: { result: "RETURNED" } });
    c.inputs = { ...c.inputs, now: Date.UTC(2026, 0, 20) };
    expect(one(c)).toEqual({ id: "inv-1", action: "RETURN", status: "mismatch", evaluator: { result: "RETURNED_LATE" }, reported: { result: "RETURNED" }, expected: { result: "RETURNED" }, row: 1 });
  });

  it("a mismatch on an invocation result has no row key", () => {
    const notFound: Reported = { result: "INVALID_BINDING", reason: "not_found" };
    const c = baseCase({ reported: notFound, expected: notFound });
    c.inputs = { ...c.inputs, bindings: { loan_id: "LN-1", x: "1" } };
    expect(one(c)).toStrictEqual({ id: "inv-1", action: "RETURN", status: "mismatch", evaluator: { result: "INVALID_BINDING", reason: "unknown_param" }, reported: notFound, expected: notFound });
  });
});

describe("reconcile: an absent reason", () => {
  it("a reason present as undefined equals an absent reason", () => {
    expect(one(baseCase({ reported: { result: "RETURNED", reason: undefined }, expected: { result: "RETURNED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "match",
      result: { result: "RETURNED" },
      row: "otherwise",
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

  it("an invocation result other than SCOPE_DENIED is never unmapped, even without a decision table", () => {
    const ont = structuredClone(library);
    delete ont.actionTypes.RETURN!.decision;
    const c = baseCase({ reported: { result: "PERMISSION_DENIED" }, expected: { result: "PERMISSION_DENIED" } }, ont);
    c.inputs = { ...c.inputs, actor: { ...c.inputs.actor, keys: [] } };
    expect(one(c, ont)).toEqual({ id: "inv-1", action: "RETURN", status: "match", result: { result: "PERMISSION_DENIED" } });
  });

  it("a reported SCOPE_DENIED is unmapped: it is internal and never reported", () => {
    expect(one(baseCase({ reported: { result: "SCOPE_DENIED" } }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "SCOPE_DENIED" });
  });

  it("a reported SCOPE_DENIED is unmapped also when the evaluator gives SCOPE_DENIED internally", () => {
    const stores = baseStores();
    stores.loans.push({ id: "LN-9", branch_id: "BR-2", state: "ACTIVE", due_date: "2026-01-15", return_condition: null });
    const c = baseCase({ reported: { result: "SCOPE_DENIED" }, expected: { result: "SCOPE_DENIED" } }, library, stores);
    c.inputs = { ...c.inputs, bindings: { loan_id: "LN-9" } };
    expect(one(c)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "SCOPE_DENIED" });
  });

  it("a reported SCOPE_DENIED is unmapped even when an unchecked decision table gives it", () => {
    const ont = structuredClone(library);
    ont.actionTypes.RETURN!.decision!.otherwise!.result = "SCOPE_DENIED";
    ont.dispositions!.SCOPE_DENIED = structuredClone(ont.dispositions!.RETURNED);
    expect(one(baseCase({ reported: { result: "SCOPE_DENIED" } }, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "SCOPE_DENIED" });
  });

  it("a reported SCOPE_DENIED without an expectation is expectation_missing: step 3 comes before step 6", () => {
    expect(one(baseCase({ reported: { result: "SCOPE_DENIED" }, expected: null }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_missing" });
  });

  it("INDETERMINATE is not reconciled; the detail is its reason", () => {
    const ont = structuredClone(library);
    const ret = ont.actionTypes.RETURN!;
    ret.conditions = ret.conditions.map((c) => (c.id === "loan_active" ? { id: "loan_active", unspecified: "x" } : c));
    expect(one(baseCase({}, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "indeterminate", detail: "unspecified" });
  });

  it("a reported SCOPE_DENIED is unmapped before INDETERMINATE", () => {
    const ont = structuredClone(library);
    const ret = ont.actionTypes.RETURN!;
    ret.conditions = ret.conditions.map((c) => (c.id === "loan_active" ? { id: "loan_active", unspecified: "x" } : c));
    expect(one(baseCase({ reported: { result: "SCOPE_DENIED" } }, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "SCOPE_DENIED" });
  });

  it("an expected result that the action cannot give is expectation_unmapped; the detail is that result", () => {
    expect(one(baseCase({ expected: { result: "NOPE_RESULT" } }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_unmapped", detail: "NOPE_RESULT" });
  });

  it("an expected SCOPE_DENIED is expectation_unmapped", () => {
    expect(one(baseCase({ expected: { result: "SCOPE_DENIED" } }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_unmapped", detail: "SCOPE_DENIED" });
  });

  it("without a decision table an expected domain result is expectation_unmapped", () => {
    const ont = structuredClone(library);
    delete ont.actionTypes.RETURN!.decision;
    const c = baseCase({ reported: { result: "PERMISSION_DENIED" }, expected: { result: "RETURNED" } }, ont);
    c.inputs = { ...c.inputs, actor: { ...c.inputs.actor, keys: [] } };
    expect(one(c, ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_unmapped", detail: "RETURNED" });
  });

  it("an unmapped expectation comes before INDETERMINATE", () => {
    const ont = structuredClone(library);
    const ret = ont.actionTypes.RETURN!;
    ret.conditions = ret.conditions.map((c) => (c.id === "loan_active" ? { id: "loan_active", unspecified: "x" } : c));
    expect(one(baseCase({ expected: { result: "NOPE_RESULT" } }, ont), ont)).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "expectation_unmapped", detail: "NOPE_RESULT" });
  });

  it("an unmapped reported result comes before an unmapped expectation", () => {
    expect(one(baseCase({ reported: { result: "BORROWED" }, expected: { result: "NOPE_RESULT" } }))).toEqual({ id: "inv-1", action: "RETURN", status: "cannot_reconcile", reason: "runtime_unmapped", detail: "BORROWED" });
  });

  it("an expected envelope result is an invocation result: it is compared, not unmapped", () => {
    expect(one(baseCase({ expected: { result: "REPLAYED" } }))).toEqual({
      id: "inv-1",
      action: "RETURN",
      status: "mismatch",
      evaluator: { result: "RETURNED" },
      reported: { result: "RETURNED" },
      expected: { result: "REPLAYED" },
      row: "otherwise",
    });
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

describe("domainResults", () => {
  it("gives each distinct decision row result in row order, then the otherwise result", () => {
    expect(domainResults(library, "BORROW")).toEqual(["REJECTED", "REFERRED", "BORROWED"]);
    expect(domainResults(library, "RETURN")).toEqual(["REJECTED", "RETURNED_LATE", "RETURNED"]);
  });

  it("gives none for an action without a decision table", () => {
    const ont = structuredClone(library);
    delete ont.actionTypes.RETURN!.decision;
    expect(domainResults(ont, "RETURN")).toEqual([]);
  });

  it("gives the otherwise result once when a decision row already gives it, in row order", () => {
    const ont = structuredClone(library);
    ont.actionTypes.RETURN!.decision!.otherwise!.result = "REJECTED";
    expect(domainResults(ont, "RETURN")).toEqual(["REJECTED", "RETURNED_LATE"]);
  });

  it("throws for an unknown action", () => {
    expect(() => domainResults(library, "NOPE")).toThrow("unknown action NOPE");
  });

  it("never gives SCOPE_DENIED", () => {
    for (const id of Object.keys(library.actionTypes)) expect(domainResults(library, id), id).not.toContain("SCOPE_DENIED");
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

  const tagged = () => thing([{ id: "thing_tag", from: "Thing", to: "Thing", via: "tag_id", table: "thing_tags" }]);
  const cols = { thing_tag: { from: "thing_id", to: "tag_id" } };

  it("projects a pure link with linkColumns: all columns are kept, from and to come from the mapped columns", () => {
    const decode = vi.fn(bool01);
    const out = projectSnapshot(tagged(), { things: [], thing_tags: [{ thing_id: "t1", tag_id: "t2", from: "junk", k: 1 }] }, decode, cols);
    expect(out).toStrictEqual({ snapshot: { objects: { Thing: [] }, links: { thing_tag: [{ thing_id: "t1", tag_id: "t2", k: 1, from: "t1", to: "t2" }] } }, defects: [] });
    expect(decode).not.toHaveBeenCalled();
  });

  it("a mapped column absent from a link row is not projected", () => {
    const out = projectSnapshot(tagged(), { things: [], thing_tags: [{ thing_id: "t1", to: "junk" }] }, bool01, cols);
    expect(out.snapshot.links).toStrictEqual({ thing_tag: [{ thing_id: "t1", from: "t1" }] });
  });

  it("a mapped column whose value is undefined is not projected", () => {
    const out = projectSnapshot(tagged(), { things: [], thing_tags: [{ thing_id: undefined, tag_id: "t2" }] }, bool01, cols);
    expect(out.snapshot.links).toStrictEqual({ thing_tag: [{ thing_id: undefined, tag_id: "t2", to: "t2" }] });
  });

  it("a pure link with linkColumns but without its store throws", () => {
    expect(() => projectSnapshot(tagged(), { things: [] }, bool01, cols)).toThrow("snapshot lacks store thing_tags");
  });

  it("a pure link without an own linkColumns entry still throws; other entries are ignored", () => {
    expect(() => projectSnapshot(tagged(), { things: [], thing_tags: [] }, bool01, { other: { from: "a", to: "b" } })).toThrow("pure link thing_tag is not projected");
    expect(() => projectSnapshot(tagged(), { things: [], thing_tags: [] }, bool01, {})).toThrow("pure link thing_tag is not projected");
  });

  it("an empty link table projects to []", () => {
    expect(projectSnapshot(tagged(), { things: [], thing_tags: [] }, bool01, cols).snapshot.links).toStrictEqual({ thing_tag: [] });
  });

  it("linkColumns is read by own key: a pure link named toString needs its own entry", () => {
    const ont = thing([{ id: "toString", from: "Thing", to: "Thing", via: "tag_id", table: "thing_tags" }]);
    expect(() => projectSnapshot(ont, { things: [], thing_tags: [] }, bool01, {})).toThrow("pure link toString is not projected");
  });

  it("a pure link without linkColumns throws before a missing object store", () => {
    expect(() => projectSnapshot(tagged(), {}, bool01)).toThrow("pure link thing_tag is not projected");
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
