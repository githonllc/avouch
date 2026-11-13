// Record parameters (SPEC section 9): the type {record: {...}, optional?} and {set: Record} in a parameter type, their
// admission (shape step), the binding of the refs inside them, typed paths, the quantifier domain {ref: <set path>},
// and the type errors. Toy vocabulary only: Branch (root), Person (global), Book (tenant, by branch_id).
import { describe, expect, it } from "vitest";
import { decide, evalPredicate, evalValue, externalResult, type Bindings, type DecideResult } from "../src/evaluate";
import { checkPredicate, ExprError, fitsType, type Expr, type Stage1Ontology, type Type } from "../src/expr";

const E = (x: unknown) => x as Expr;
const ref = (r: string) => E({ ref: r });
const lit = (v: string | number | (string | number)[]) => E({ lit: v });
const op = (k: string, ...a: Expr[]) => E({ [k]: a });
const q = (k: "exists" | "none" | "all", as: string, inn: unknown, where?: Expr) => E({ [k]: where === undefined ? { as, in: inn } : { as, in: inn, where } });

const NOW = Date.UTC(2026, 2, 10, 12);
const Address: Type = { record: { city: "enum", zip: "id" }, optional: ["zip"] };
const Stop: Type = {
  record: {
    book_id: { ref: "Book" },
    count: "integer",
    task_ids: { set: { ref: "Book" } },
    address: Address,
    tags: { set: "enum" },
    legs: { set: { record: { city: "enum" } } },
    note: "string",
  },
  optional: ["address", "tags", "legs", "note"],
};
const allShelf = q("all", "s", ref("stops"), op("eq", ref("s.book_id.state"), lit("SHELF")));
const ont: Stage1Ontology = {
  scope: { by: "branch_id", global: [{ type: "Person" }], root: { type: "Branch" } },
  dispositions: { REFUSED: { class: "rejected" }, LENT: { class: "applied" } },
  objectTypes: {
    Branch: { datasource: "branches", properties: {} },
    Person: { datasource: "persons", properties: {} },
    Book: { datasource: "books", properties: { state: { type: "enum" }, labels: { type: { set: "enum" } } } },
  },
  linkTypes: [],
  actionTypes: {
    plan: {
      parameters: { stops: { type: { set: Stop } }, lead: { type: Stop, optional: true } },
      permission: { none: "anyone" },
      conditions: [{ id: "all_shelf", expr: allShelf }],
      decision: { hitPolicy: "first", rows: [{ when: { fails: "all_shelf" }, result: "REFUSED" }], otherwise: { result: "LENT" } },
    },
  },
};
const snapshot = {
  objects: {
    Branch: [{ id: "b1" }, { id: "b2" }],
    Person: [],
    Book: [
      { id: "bk1", branch_id: "b1", state: "SHELF", labels: ["NEW"] },
      { id: "bk2", branch_id: "b2", state: "SHELF", labels: [] }, // only in b2
      { id: "bk3", branch_id: "b1", state: "LOST", labels: [] },
    ],
  },
};
const actor = { id: "u1", keys: [], kind: "user" };
const run = (bindings: Bindings): DecideResult => decide(ont, "plan", snapshot, "b1", bindings, actor, NOW);
const stop = (x: Record<string, unknown> = {}) => ({ book_id: "bk1", count: 1, task_ids: [], ...x });
const lent = { layer: "domain", result: "LENT", class: "applied", row: "otherwise" };
const bad = (reason: string, path?: string) => ({ layer: "invocation", result: "INVALID_BINDING", param: "stops", reason, ...(path === undefined ? {} : { path }) });
const env = (bindings: Bindings) => ({ action: "plan", snapshot, scope: "b1", bindings, actor, now: NOW });
const pred = (e: Expr, bindings: Bindings) => {
  checkPredicate(ont, e, { action: "plan", locals: {} });
  return evalPredicate(ont, e, env(bindings));
};
const typeError = (e: Expr) => expect(() => checkPredicate(ont, e, { action: "plan", locals: {} })).toThrow(ExprError);

describe("admission of a record parameter (shape step)", () => {
  it("a record with every required field, absent and null optional fields, and an undeclared field is admitted", () => {
    expect(run({ stops: [stop()] })).toEqual(lent);
    expect(run({ stops: [stop({ address: null, tags: null, extra: { any: 1 } })] })).toEqual(lent);
    expect(run({ stops: [stop({ address: { city: "Oslo" } })] })).toEqual(lent);
    expect(run({ stops: [] })).toEqual(lent);
  });
  it("a required field that is absent or null is type, with the path of the field", () => {
    const { book_id: _, ...noBook } = stop();
    expect(run({ stops: [stop(), noBook] })).toEqual(bad("type", "stops[1].book_id"));
    expect(run({ stops: [stop({ count: null })] })).toEqual(bad("type", "stops[0].count"));
  });
  it("a null element of a set is type", () => expect(run({ stops: [stop(), null] })).toEqual(bad("type", "stops[1]")));
  it("a nested field that does not fit its type is type, with the nested path", () => {
    expect(run({ stops: [stop({ address: { city: 3 } })] })).toEqual(bad("type", "stops[0].address.city"));
    expect(run({ stops: [stop({ address: { zip: "z" } })] })).toEqual(bad("type", "stops[0].address.city"));
    expect(run({ stops: [stop({ task_ids: ["bk1", ""] })] })).toEqual(bad("type", "stops[0].task_ids[1]"));
    expect(run({ stops: [stop({ legs: [{ city: "A" }, {}] })] })).toEqual(bad("type", "stops[0].legs[1].city"));
    expect(run({ stops: ["bk1"] })).toEqual(bad("type", "stops[0]"));
  });
  it("only an absent top-level parameter is missing; a top-level misfit has no path", () => {
    expect(run({})).toEqual(bad("missing"));
    expect(run({ stops: null })).toEqual(bad("missing"));
    expect(run({ stops: { book_id: "bk1" } })).toEqual(bad("type"));
    expect(run({ stops: [], lead: [] })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "lead", reason: "type" });
  });
  it("fitsType reads a record by its declared fields", () => {
    expect(fitsType({ city: "A" }, Address)).toBe(true);
    expect(fitsType({ city: "A", zip: null, other: [1] }, Address)).toBe(true);
    expect(fitsType({ zip: "z" }, Address)).toBe(false);
    expect(fitsType(["A"], Address)).toBe(false);
    expect(fitsType(null, Address)).toBe(false);
  });
});

describe("binding of the refs inside a record parameter", () => {
  it("a nested id that does not resolve is not_found, with param and path", () =>
    expect(run({ stops: [stop(), stop({ task_ids: ["bk1", "nope"] })] })).toEqual(bad("not_found", "stops[1].task_ids[1]")));
  it("a nested id only in another branch is SCOPE_DENIED, and is not_found outward", () => {
    const denied = run({ stops: [stop({ book_id: "bk2" })] });
    expect(denied).toEqual({ layer: "invocation", result: "SCOPE_DENIED", param: "stops", path: "stops[0].book_id" });
    const missing = run({ stops: [stop({ book_id: "nope" })] });
    if (denied.layer === "indeterminate" || missing.layer === "indeterminate") throw new Error("unexpected INDETERMINATE");
    expect(externalResult(denied)).toEqual(externalResult(missing));
    expect(externalResult(missing)).toEqual({ result: "INVALID_BINDING", param: "stops", reason: "not_found", path: "stops[0].book_id" });
  });
  it("values are visited in declared field order, then array order; the first failure is reported", () => {
    // value keys in reverse order: the declared order (book_id before task_ids) decides
    expect(run({ stops: [{ task_ids: ["nope"], count: 1, book_id: "bk2" }] })).toEqual({ layer: "invocation", result: "SCOPE_DENIED", param: "stops", path: "stops[0].book_id" });
    expect(run({ stops: [stop({ task_ids: ["nope", "bk2"] })] })).toEqual(bad("not_found", "stops[0].task_ids[0]"));
    expect(run({ stops: [stop({ book_id: "nope" }), stop({ book_id: "bk2" })] })).toEqual(bad("not_found", "stops[0].book_id"));
  });
  it("binding is all-or-nothing: a failure in an optional parameter stops the invocation", () =>
    expect(run({ stops: [], lead: stop({ book_id: "nope" }) })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "lead", reason: "not_found", path: "lead.book_id" }));
  it("all refs resolve: the decision runs", () => {
    expect(run({ stops: [stop(), stop({ task_ids: ["bk1", "bk3"] })] })).toEqual(lent);
    expect(run({ stops: [stop(), stop({ book_id: "bk3" })] })).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: 0 });
  });
});

describe("evaluation over record parameters", () => {
  const stops = [stop(), stop({ book_id: "bk3", tags: ["A"], legs: [{ city: "Oslo" }, { city: "Rome" }] })];
  it("exists, all and none over a set of records", () => {
    const shelf = op("eq", ref("s.book_id.state"), lit("SHELF"));
    expect(pred(q("exists", "s", ref("stops"), shelf), { stops })).toBe("T");
    expect(pred(q("all", "s", ref("stops"), shelf), { stops })).toBe("F");
    expect(pred(q("none", "s", ref("stops"), op("eq", ref("s.count"), lit(2))), { stops })).toBe("T");
    expect(pred(q("all", "s", ref("stops"), shelf), { stops: [] })).toBe("T");
  });
  it("a quantifier nested two levels (a set of records inside a record)", () => {
    const rome = q("exists", "s", ref("stops"), q("exists", "l", ref("s.legs"), op("eq", ref("l.city"), lit("Rome"))));
    expect(pred(rome, { stops })).toBe("T");
    expect(pred(rome, { stops: [stop()] })).toBe("F");
  });
  it("a quantifier over a set of refs inside a record binds objects", () => {
    const lost = q("exists", "s", ref("stops"), q("exists", "t", ref("s.task_ids"), op("eq", ref("t.state"), lit("LOST"))));
    expect(pred(lost, { stops: [stop({ task_ids: ["bk1", "bk3"] })] })).toBe("T");
    expect(pred(lost, { stops: [stop({ task_ids: ["bk1"] })] })).toBe("F");
  });
  it("a field read through a single record, and a ref field read as an object property", () => {
    const lead = stop({ address: { city: "Oslo" } });
    expect(evalValue(ont, ref("lead.address.city"), env({ lead }))).toBe("Oslo");
    expect(evalValue(ont, ref("lead.address.zip"), env({ lead }))).toBe(null);
    expect(evalValue(ont, ref("lead.book_id"), env({ lead }))).toBe("bk1");
    expect(evalValue(ont, ref("lead.book_id.state"), env({ lead }))).toBe("SHELF");
    expect(pred(op("eq", ref("lead.book_id.state"), lit("SHELF")), { lead })).toBe("T");
    expect(pred(op("eq", ref("lead.book_id.state"), lit("SHELF")), {})).toBe("U");
    expect(pred(op("isNull", ref("lead.address")), { lead: stop() })).toBe("T");
  });
  it("a set field works with in and subsetOf", () => {
    const lead = stop({ tags: ["A", "B"] });
    expect(pred(op("in", lit("A"), ref("lead.tags")), { lead })).toBe("T");
    expect(pred(op("subsetOf", ref("lead.tags"), lit(["A", "B", "C"])), { lead })).toBe("T");
    expect(pred(op("in", ref("lead.book_id"), ref("lead.task_ids")), { lead })).toBe("F");
  });
  it("a null optional collection is the empty set as a quantifier domain, while subsetOf gives U", () => {
    const lead = stop();
    expect(pred(q("all", "t", ref("lead.tags"), op("eq", ref("t"), lit("A"))), { lead })).toBe("T");
    expect(pred(q("exists", "t", ref("lead.tags")), { lead })).toBe("F");
    expect(pred(op("subsetOf", ref("lead.tags"), lit(["A"])), { lead })).toBe("U");
    expect(pred(q("all", "t", ref("lead.tags"), op("eq", ref("t"), lit("A"))), { lead: stop({ tags: ["A", "B"] }) })).toBe("F");
  });
});

describe("type errors", () => {
  it("a record or a set of records is not an operand", () => {
    typeError(op("eq", ref("lead.address"), ref("lead.address")));
    typeError(op("neq", ref("lead"), ref("lead")));
    typeError(op("isNull", lit("x")));
    typeError(op("in", ref("lead"), ref("stops")));
    typeError(op("subsetOf", ref("stops"), ref("stops")));
    typeError(op("lt", ref("lead.address"), ref("lead.address")));
    expect(() => checkPredicate(ont, op("isNull", ref("lead.address")), { action: "plan", locals: {} })).not.toThrow();
  });
  it("a quantifier domain is a nav or a set path without an object property", () => {
    typeError(q("exists", "x", ref("lead.book_id.labels")));
    typeError(q("exists", "x", ref("lead.count")));
    typeError(q("exists", "x", ref("lead")));
    typeError(q("exists", "x", ref("actor.keys")));
    typeError(q("exists", "x", lit(["A"])));
    expect(() => checkPredicate(ont, q("exists", "x", ref("lead.tags")), { action: "plan", locals: {} })).not.toThrow();
  });
  it("a path names declared fields, and reads at most one property of an object", () => {
    typeError(op("isNull", ref("lead.nope")));
    typeError(op("isNull", ref("lead.book_id.state.x")));
    typeError(op("isNull", ref("lead.count.x")));
    typeError(q("exists", "s", ref("stops"), op("isNull", ref("s.nope"))));
  });
  it("a quantifier variable over a record set does not reuse a bound name and is not an object binding", () => {
    typeError(q("exists", "s", ref("stops"), q("exists", "s", ref("s.legs"))));
    typeError(q("exists", "s", ref("stops"), E({ derived: { id: "x", of: { ref: "s" } } })));
  });
});
