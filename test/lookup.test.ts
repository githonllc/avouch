// Lookup (SPEC section 9): the node {lookup: {type, id: {ref}}} as the `in` of a quantifier. Toy vocabulary only:
// Branch (root), Person (global), Member and Book (tenant, by branch_id).
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import schemaText from "../ontology.schema.json?raw";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";
import { check } from "../src/checker";
import type { SourceFacts } from "../src/contract";
import { decide, evalPredicate, type Bindings, type DecideResult, type Row, type Snapshot } from "../src/evaluate";
import { bindVariable, checkPermissionWhen, checkPredicate, newReads, type Expr, type ExprContext, type Stage1Ontology } from "../src/expr";
import { applyPatch } from "../src/patch";
import { showExpr } from "../src/query";
import { absorbingQuantifiers, freeNullableRefs, mayNullIn } from "../src/unknown";

const E = (x: unknown) => x as Expr;
const ref = (r: string) => E({ ref: r });
const op = (k: string, ...a: Expr[]) => E({ [k]: a });
const q = (k: "exists" | "none" | "all", as: string, inn: unknown, where?: Expr) => E({ [k]: where === undefined ? { as, in: inn } : { as, in: inn, where } });
const lk = (type: string, path: string) => ({ lookup: { type, id: { ref: path } } });

const NOW = Date.UTC(2026, 2, 10, 12);
const memberFound = op("or", op("isNull", ref("member_ref")), q("exists", "m", lk("Member", "member_ref")));
const ont: Stage1Ontology = {
  scope: { by: "branch_id", global: [{ type: "Person" }], root: { type: "Branch" } },
  dispositions: { NOT_FOUND: { class: "rejected" }, OK: { class: "applied" } },
  objectTypes: {
    Branch: { datasource: "branches", properties: {} },
    Person: { datasource: "persons", properties: {} },
    Member: { datasource: "members", properties: { blocked_until: { type: "timestamp" } } },
    Book: { datasource: "books", properties: { state: { type: "enum" } } },
  },
  linkTypes: [],
  actionTypes: {
    probe: {
      parameters: {
        member_ref: { type: "id", optional: true },
        member_id: { type: { ref: "Member" }, optional: true },
        book_ids: { type: { set: "id" }, optional: true },
        stops: { type: { set: { record: { book: "id", books: { set: "id" } }, optional: ["books"] } }, optional: true },
        note: { type: "string", optional: true },
        other_ref: { type: { ref: "Book" }, optional: true },
      },
      permission: { none: "anyone" },
      conditions: [{ id: "member_found", expr: memberFound }],
      decision: { hitPolicy: "first", rows: [{ when: { fails: "member_found" }, result: "NOT_FOUND" }], otherwise: { result: "OK" } },
    },
  },
};
const objects: Record<string, Row[]> = {
  Branch: [{ id: "b1" }, { id: "b2" }],
  Person: [{ id: "p1" }],
  Member: [
    { id: "m1", branch_id: "b1", blocked_until: NOW - 1000 },
    { id: "m2", branch_id: "b2", blocked_until: null }, // only in b2
  ],
  Book: [
    { id: "k1", branch_id: "b1", state: "SHELF" },
    { id: "k2", branch_id: "b2", state: "SHELF" }, // only in b2
  ],
};
const snapshot: Snapshot = { objects, links: {} };
const withObjects = (patch: Record<string, Row[] | undefined>): Snapshot => {
  const o: Record<string, Row[]> = { ...objects };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete o[k];
  else o[k] = v;
  return { objects: o, links: {} };
};
const actor = { id: "u1", keys: [], kind: "user" };
const ctx = (): ExprContext => ({ action: "probe", locals: {} });
const typeError = (e: unknown, re: RegExp) => expect(() => checkPredicate(ont, e, ctx())).toThrow(re);
const accepted = (e: unknown) => expect(() => checkPredicate(ont, e, ctx())).not.toThrow();
const pred = (e: Expr, bindings: Bindings, snap: Snapshot = snapshot, scope = "b1") => {
  checkPredicate(ont, e, ctx());
  return evalPredicate(ont, e, { action: "probe", snapshot: snap, scope, bindings, actor, now: NOW });
};
const run = (bindings: Bindings, snap: Snapshot = snapshot): DecideResult => decide(ont, "probe", snap, "b1", bindings, actor, NOW);

const existsM = (path = "member_ref", type = "Member") => q("exists", "m", lk(type, path));
const blocked = op("isNotNull", ref("m.blocked_until"));

describe("lookup type check", () => {
  const takes = /lookup takes \{type: <object type>, id: \{ref: <path>\}\}/;
  it("a literal id is not an operand", () => {
    typeError(q("exists", "m", { lookup: { type: "Member", id: { lit: "m1" } } }), takes);
  });
  it("an extra key in the lookup is rejected", () => {
    typeError(q("exists", "m", { lookup: { type: "Member", id: { ref: "member_ref" }, extra: 1 } }), takes);
  });
  it("an undeclared object type is rejected", () => {
    typeError(existsM("member_ref", "Nope"), /object type Nope is not declared/);
  });
  it("a path that reads a property of an object is rejected", () => {
    typeError(existsM("member_id.blocked_until"), /a quantifier domain reads no property of an object/);
  });
  it("the heads now, actor and self are rejected", () => {
    const re = /a lookup id is a parameter, a quantifier variable or a field of a record, not (now|actor|self)/;
    for (const path of ["now", "actor.id", "self"]) typeError(existsM(path), re);
  });
  it("the path has type id or {ref: T} with the same T", () => {
    typeError(existsM("other_ref"), /lookup id other_ref has type \{ref: Book\}; a lookup of Member needs id or \{ref: Member\}/);
    typeError(existsM("book_ids"), /has type \{set: id\}/);
    typeError(existsM("note"), /has type string/);
  });
  it("a lookup in a value position or a predicate position is rejected", () => {
    const re = /lookup is valid only as the `in` of a quantifier/;
    typeError(op("isNull", E(lk("Member", "member_ref"))), re);
    typeError(lk("Member", "member_ref"), re);
    typeError(op("and", E(lk("Member", "member_ref")), op("isNull", ref("member_ref"))), re);
  });
  it("a lookup in conditional_when is rejected before the type check", () => {
    expect(() => checkPermissionWhen(ont, { exists: { as: "m", in: lk("Member", "member_ref") } }, "probe")).toThrow(/exists is not allowed in conditional_when/);
  });
  it("an id, a {ref: Member}, a record field and a set element are accepted", () => {
    accepted(existsM("member_ref"));
    accepted(existsM("member_id"));
    accepted(q("all", "s", ref("stops"), q("exists", "k", lk("Book", "s.book"))));
    accepted(q("all", "b", ref("book_ids"), q("exists", "k", lk("Book", "b"))));
  });
});

describe("lookup evaluation", () => {
  it("a visible id gives its row", () => {
    expect(pred(existsM(), { member_ref: "m1" })).toBe("T");
    expect(pred(q("all", "m", lk("Member", "member_ref"), blocked), { member_ref: "m1" })).toBe("T");
    expect(pred(q("none", "m", lk("Member", "member_ref"), blocked), { member_ref: "m1" })).toBe("F");
  });
  it("an absent id is the empty set", () => {
    const b = { member_ref: "zz" };
    expect(pred(existsM(), b)).toBe("F");
    expect(pred(q("all", "m", lk("Member", "member_ref"), blocked), b)).toBe("T");
    expect(pred(q("none", "m", lk("Member", "member_ref"), blocked), b)).toBe("T");
  });
  it("an id of another type is the empty set", () => {
    expect(pred(existsM(), { member_ref: "k1" })).toBe("F");
  });
  it("an id only in another tenant is the empty set, and decide does not tell it from an absent id", () => {
    expect(pred(existsM(), { member_ref: "m2" })).toBe("F");
    expect(run({ member_ref: "m2" })).toEqual(run({ member_ref: "zz" }));
  });
  it("one id in two tenants gives the row of the scope", () => {
    const snap = withObjects({ Member: [{ id: "m3", branch_id: "b1", blocked_until: NOW }, { id: "m3", branch_id: "b2", blocked_until: null }] });
    expect(pred(q("all", "m", lk("Member", "member_ref"), blocked), { member_ref: "m3" }, snap)).toBe("T");
    expect(pred(existsM(), { member_ref: "m3" }, snap)).toBe("T");
  });
  it("a root type: the scope is the only visible row", () => {
    expect(pred(existsM("member_ref", "Branch"), { member_ref: "b1" })).toBe("T");
    expect(pred(existsM("member_ref", "Branch"), { member_ref: "b2" })).toBe("F");
  });
  it("a global type is visible from any scope", () => {
    expect(pred(existsM("member_ref", "Person"), { member_ref: "p1" })).toBe("T");
    expect(pred(existsM("member_ref", "Person"), { member_ref: "p1" }, snapshot, "b2")).toBe("T");
  });
  it("a null id does not read the type", () => {
    expect(pred(existsM(), {}, withObjects({ Member: undefined }))).toBe("F");
  });
  it("a non-null id reads the type", () => {
    expect(() => pred(existsM(), { member_ref: "m1" }, withObjects({ Member: undefined }))).toThrow("snapshot lacks object type Member");
  });
  it("two rows with one id in one scope are a corrupt snapshot", () => {
    const snap = withObjects({ Member: [{ id: "m1", branch_id: "b1", blocked_until: null }, { id: "m1", branch_id: "b1", blocked_until: null }] });
    expect(() => pred(existsM(), { member_ref: "m1" }, snap)).toThrow(/snapshot has two Member rows with id m1 in one scope/);
  });
  it("a {ref: Member} path gives its row", () => {
    expect(pred(existsM("member_id"), { member_id: "m1" })).toBe("T");
    expect(pred(q("none", "m", lk("Member", "member_id"), blocked), { member_id: "m1" })).toBe("F");
  });
});

describe("lookup through decide", () => {
  const ok = { layer: "domain", result: "OK", class: "applied", row: "otherwise" };
  const notFound = { layer: "domain", result: "NOT_FOUND", class: "rejected", row: 0 };
  it("an absent or a visible id is OK; an id that does not resolve is NOT_FOUND, never INVALID_BINDING", () => {
    expect(run({})).toEqual(ok);
    expect(run({ member_ref: "m1" })).toEqual(ok);
    expect(run({ member_ref: "zz" })).toEqual(notFound);
    expect(run({ member_ref: "m2" })).toEqual(notFound);
  });
});

describe("lookup over a set of ids in a record parameter", () => {
  const one = q("all", "s", ref("stops"), q("exists", "k", lk("Book", "s.book")));
  const many = q("all", "s", ref("stops"), q("all", "b", ref("s.books"), q("exists", "k", lk("Book", "b"))));
  it("every id visible is T; an absent id or an id in another tenant is F", () => {
    expect(pred(one, { stops: [{ book: "k1" }] })).toBe("T");
    expect(pred(one, { stops: [{ book: "k1" }, { book: "zz" }] })).toBe("F");
    expect(pred(one, { stops: [{ book: "k2" }] })).toBe("F");
    expect(pred(many, { stops: [{ book: "k1", books: ["k1"] }, { book: "k1" }] })).toBe("T");
    expect(pred(many, { stops: [{ book: "k1", books: ["k1", "zz"] }] })).toBe("F");
    expect(pred(many, { stops: [{ book: "k1", books: ["k2"] }] })).toBe("F");
  });
  it("an absent list is T (vacuous truth)", () => {
    expect(pred(one, {})).toBe("T");
    expect(pred(many, {})).toBe("T");
  });
});

describe("lookup reads", () => {
  it("a lookup records no read; its body reads as any quantifier body", () => {
    const c = newReads();
    checkPredicate(ont, existsM(), { action: "probe", locals: {}, collect: c });
    expect(c.reads).toEqual([]);
    const d = newReads();
    checkPredicate(ont, q("exists", "m", lk("Member", "member_ref"), blocked), { action: "probe", locals: {}, collect: d });
    expect(d.reads).toEqual([{ prop: "Member.blocked_until" }]);
  });
});

describe("lookup on the library example", () => {
  const lib = parse(ontologyText);
  const facts: SourceFacts = buildLibraryFacts(doc, libraryEvidence(), config);
  const o = applyPatch(lib, [{ op: "add", path: "/actionTypes/BORROW/parameters/member_ref", value: { type: "id", optional: true, cite: { doc: "L6", quote: "BORROW takes member_id" } } }]);
  const BORROW: ExprContext = { action: "BORROW", locals: {} };
  const lte = op("lte", ref("m.blocked_until"), ref("now"));
  it("R12: the lookup id is not counted; the body is analysed", () => {
    expect(freeNullableRefs(o, existsM(), mayNullIn(o, facts, BORROW))).toEqual([]);
    expect(freeNullableRefs(o, op("or", op("isNull", ref("member_ref")), existsM()), mayNullIn(o, facts, BORROW))).toEqual(["member_ref"]);
    expect(absorbingQuantifiers(o, facts, q("all", "m", lk("Member", "member_ref"), lte), BORROW)).toEqual(["$.all"]);
    expect(absorbingQuantifiers(o, facts, q("all", "m", lk("Member", "member_ref"), op("or", op("isNull", ref("m.blocked_until")), lte)), BORROW)).toEqual([]);
    expect(mayNullIn(o, facts, bindVariable(BORROW, "m", { object: "Member" }))("m")).toBe(false);
  });
  it("R1: the unresolved message names lookup", () => {
    const bad = applyPatch(lib, [
      { op: "add", path: "/actionTypes/BORROW/parameters/book_id/optional", value: true },
      { op: "add", path: "/actionTypes/BORROW/parameters/book_id/unresolved", value: "domain" },
    ]);
    const vs = check(bad, facts).violations.filter((x) => x.rule === "R1" && x.key === "actionTypes.BORROW.parameters.book_id");
    expect(vs.some((x) => x.msg.includes("resolve it in a condition with lookup"))).toBe(true);
  });
});

describe("lookup in query", () => {
  it("shows a lookup domain", () => {
    expect(showExpr(existsM())).toBe("exists m in lookup(Member, member_ref)");
    expect(showExpr(q("all", "m", lk("Member", "member_ref"), blocked))).toBe("all m in lookup(Member, member_ref) where m.blocked_until is not null");
    expect(showExpr(memberFound)).toBe("member_ref is null or (exists m in lookup(Member, member_ref))");
    expect(showExpr({ exists: { as: "m", in: { lookup: { type: 1 } } } }).startsWith("<?>")).toBe(true);
    // Extra keys are not a lookup: shown as an unknown node, not as a valid one.
    expect(showExpr({ exists: { as: "m", in: { lookup: { type: "Member", id: { ref: "member_ref" }, zz: 1 } } } }).startsWith("<?>")).toBe(true);
    expect(showExpr({ exists: { as: "m", in: { lookup: { type: "Member", id: { ref: "member_ref", zz: 1 } } } } }).startsWith("<?>")).toBe(true);
    expect(showExpr({ exists: { as: "m", in: { lookup: { type: "Member", id: { ref: "member_ref" } }, zz: 1 } } }).startsWith("<?>")).toBe(true);
  });
});

describe("lookup in the JSON Schema", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(schemaText));
  const withExpr = (expr: unknown) => {
    const o = parse(ontologyText);
    o.actionTypes.BORROW.parameters.member_ref = { type: "id", optional: true, cite: { doc: "L6", quote: "BORROW takes member_id" } };
    o.actionTypes.BORROW.conditions.push({ id: "member_found", expr, cites: [{ cite: { doc: "L6", quote: "BORROW takes member_id" } }] });
    return o;
  };
  it("a condition with a lookup validates; a literal id and an extra key are rejected", () => {
    expect(validate(withExpr(memberFound))).toBe(true);
    expect(validate(withExpr({ exists: { as: "m", in: { lookup: { type: "Member", id: { lit: "m1" } } } } }))).toBe(false);
    expect(validate(withExpr({ exists: { as: "m", in: { lookup: { type: "Member", id: { ref: "x" }, extra: 1 } } } }))).toBe(false);
  });
});
