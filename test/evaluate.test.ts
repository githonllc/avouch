// Decision semantics (src/expr.ts, src/evaluate.ts): two-level evaluation, Kleene logic, quantifiers, scope modes,
// the invocation layer and its order (shape -> permission -> binding and scope -> decision), and INDETERMINATE.
// Toy vocabulary only: Branch (root), Person (global), Member, Book, Loan (tenant, by branch_id).
import { describe, expect, it } from "vitest";
import { decide, evalPredicate, evalValue, externalResult, INVOCATION_RESULTS, UndefinedDerived, type Actor, type Bindings, type DecideResult, type Row, type Snapshot } from "../src/evaluate";
import { checkPredicate, ExprError, SCALAR_TYPE_NAMES, type Expr, type Stage1Ontology } from "../src/expr";

// ---------- expression builders ----------
const ref = (r: string): Expr => ({ ref: r });
const lit = (v: string | number | (string | number)[]): Expr => ({ lit: v });
const eq = (a: Expr, b: Expr): Expr => ({ eq: [a, b] });
const lt = (a: Expr, b: Expr): Expr => ({ lt: [a, b] });
const and = (...xs: Expr[]): Expr => ({ and: xs });
const or = (...xs: Expr[]): Expr => ({ or: xs });
const not = (a: Expr): Expr => ({ not: [a] });
const isNull = (a: Expr): Expr => ({ isNull: [a] });
const inSet = (a: Expr, s: Expr): Expr => ({ in: [a, s] });
const subsetOf = (a: Expr, b: Expr): Expr => ({ subsetOf: [a, b] });
const plus = (a: Expr, b: Expr): Expr => ({ plus: [a, b] });
const dateIn = (a: Expr, b: Expr): Expr => ({ dateIn: [a, b] });
const derived = (id: string, of: string): Expr => ({ derived: { id, of: { ref: of } } });
const nav = (from: string, link: string, dir: "forward" | "reverse") => ({ nav: { from: { ref: from }, link, dir } });
const exists = (as: string, inn: ReturnType<typeof nav>, where?: Expr): Expr => ({ exists: where ? { as, in: inn, where } : { as, in: inn } });
const all = (as: string, inn: ReturnType<typeof nav>, where?: Expr): Expr => ({ all: where ? { as, in: inn, where } : { as, in: inn } });
const none = (as: string, inn: ReturnType<typeof nav>, where?: Expr): Expr => ({ none: where ? { as, in: inn, where } : { as, in: inn } });

// ---------- fixture ----------
const NOW = Date.UTC(2026, 2, 10, 12);
const DAY_MS = 86_400_000;

const otherwiseNoted = { hitPolicy: "first" as const, rows: [], otherwise: { result: "NOTED" } };

const base: Stage1Ontology = {
  scope: { by: "branch_id", global: [{ type: "Person" }], root: { type: "Branch" } },
  dispositions: {
    REFUSED: { class: "rejected" },
    NOTED: { class: "recorded" },
    HELD: { class: "pending" },
    LENT: { class: "applied" },
    RENEWED: { class: "applied" },
  },
  objectTypes: {
    Branch: { datasource: "branches", properties: { timezone: { type: "timezone" } } },
    Person: { datasource: "persons", properties: {} },
    Member: { datasource: "members", properties: { state: { type: "enum" } } },
    Book: { datasource: "books", properties: { state: { type: "enum" } } },
    Loan: { datasource: "loans", properties: { state: { type: "enum" }, due_at: { type: "timestamp" }, renewals: { type: "integer" } } },
  },
  linkTypes: [
    { id: "member_person", from: "Member", to: "Person", via: "person_id" },
    { id: "loan_member", from: "Loan", to: "Member", via: "member_id" },
    { id: "loan_book", from: "Loan", to: "Book", via: "book_id", table: "loans" },
    { id: "book_author", from: "Book", to: "Person", via: "person_id", table: "book_authors" },
  ],
  derivedProperties: {
    member_standing: { of: "Member", type: "enum", expr: ref("self.state") },
    loan_risk: { of: "Loan", type: "enum" },
  },
  actionTypes: {
    // For direct evalValue / evalPredicate calls; has no decision table.
    probe: {
      parameters: {
        p: { type: "integer", optional: true },
        q: { type: "integer", optional: true },
        e: { type: "enum", optional: true },
        t: { type: "timestamp", optional: true },
        d: { type: "duration", optional: true },
        tz: { type: "timezone", optional: true },
        ks: { type: { set: "string" }, optional: true },
        m: { type: { ref: "Member" }, optional: true },
        loan: { type: { ref: "Loan" }, optional: true },
        person: { type: { ref: "Person" }, optional: true },
      },
      permission: { none: "anyone" },
      conditions: [],
    },
    checkout: {
      parameters: {
        member: { type: { ref: "Member" } },
        book: { type: { ref: "Book" } },
        sponsor: { type: { ref: "Member" }, optional: true },
        others: { type: { set: { ref: "Member" } }, optional: true },
      },
      permission: { keys: ["loan.create"] },
      conditions: [
        { id: "member_good", expr: eq(ref("member.state"), lit("GOOD")) },
        { id: "sponsor_good", expr: eq(ref("sponsor.state"), lit("GOOD")) },
      ],
      decision: {
        hitPolicy: "first",
        rows: [
          { when: { fails: "member_good" }, result: "REFUSED" },
          { when: { passes: "sponsor_good" }, result: "HELD", next: { actions: ["confirm"] } },
        ],
        otherwise: { result: "LENT" },
      },
    },
    hold: {
      parameters: { e: { type: "enum", optional: true } },
      permission: { none: "anyone" },
      conditions: [{ id: "is_a", expr: eq(ref("e"), lit("A")) }],
      decision: {
        hitPolicy: "first",
        rows: [
          { when: { passes: "is_a" }, result: "HELD" },
          { when: { fails: "is_a" }, result: "REFUSED" },
        ],
      },
    },
    strict: {
      parameters: { e: { type: "enum", optional: true } },
      permission: { none: "anyone" },
      conditions: [{ id: "is_a", expr: eq(ref("e"), lit("A")) }],
      decision: { hitPolicy: "first", rows: [{ when: { passes: "is_a" }, result: "HELD" }] },
    },
    renew: {
      parameters: { loan: { type: { ref: "Loan" } } },
      permission: { none: "anyone" },
      conditions: [
        { id: "closed", expr: eq(ref("loan.state"), lit("CLOSED")) },
        { id: "risky", expr: eq(derived("loan_risk", "loan"), lit("HIGH")) },
      ],
      decision: {
        hitPolicy: "first",
        rows: [
          { when: { passes: "closed" }, result: "REFUSED" },
          { when: { fails: "risky" }, result: "RENEWED" },
        ],
        otherwise: { result: "NOTED" },
      },
    },
    renew_vague: {
      parameters: { loan: { type: { ref: "Loan" } } },
      permission: { none: "anyone" },
      conditions: [
        { id: "closed", expr: eq(ref("loan.state"), lit("CLOSED")) },
        { id: "vague", unspecified: "the source names the rule but gives no test" },
      ],
      decision: {
        hitPolicy: "first",
        rows: [
          { when: { passes: "closed" }, result: "REFUSED" },
          { when: { passes: "vague" }, result: "RENEWED" },
        ],
        otherwise: { result: "NOTED" },
      },
    },
    renew_guarded: {
      parameters: { loan: { type: { ref: "Loan" } } },
      permission: { none: "anyone" },
      conditions: [{ id: "guarded", expr: and(eq(ref("loan.state"), lit("NEVER")), isNull(derived("loan_risk", "loan"))) }],
      decision: { hitPolicy: "first", rows: [{ when: { passes: "guarded" }, result: "RENEWED" }], otherwise: { result: "NOTED" } },
    },
    register: {
      parameters: {
        member: { type: { ref: "Member" } },
        branch: { type: { ref: "Branch" } },
        at: { type: "timestamp" },
        day: { type: "date" },
        tz: { type: "timezone" },
        ks: { type: { set: "string" } },
        n: { type: "integer" },
      },
      permission: { none: "anyone" },
      conditions: [],
      decision: otherwiseNoted,
    },
    waive: {
      parameters: { member: { type: { ref: "Member" } } },
      permission: { keys: ["fee.waive"], conditional_keys: ["fee.waive.large"] },
      conditions: [],
      decision: otherwiseNoted,
    },
    audit: { permission: "unknown", conditions: [], decision: otherwiseNoted },
    transfer: { permission: { any_of: [{ keys: ["transfer.in"] }, { keys: ["transfer.out"] }] }, conditions: [], decision: otherwiseNoted },
    invite: { permission: { keys: ["member.invite"], principals: { kinds: ["user"], cite: "only staff users may invite" } }, conditions: [], decision: otherwiseNoted },
    invite_any: {
      permission: { any_of: [{ keys: ["member.invite"], principals: { kinds: ["user"] } }, { keys: ["branch.admin"] }] },
      conditions: [],
      decision: otherwiseNoted,
    },
  },
};

const snapshot: Snapshot = {
  objects: {
    Branch: [
      { id: "b1", timezone: "America/Los_Angeles" },
      { id: "b2", timezone: "UTC" },
    ],
    Person: [{ id: "p1" }, { id: "p2" }],
    Member: [
      { id: "m1", branch_id: "b1", person_id: "p1", state: "GOOD" },
      { id: "m1", branch_id: "b2", person_id: "p1", state: "BANNED" }, // same id, other branch (composite key)
      { id: "m2", branch_id: "b1", person_id: "p2", state: "GOOD" },
      { id: "m3", branch_id: "b2", person_id: "p2", state: "GOOD" }, // exists only in b2
      { id: "m4", branch_id: "b1", person_id: null, state: "LAPSED" },
    ],
    Book: [
      { id: "bk1", branch_id: "b1", state: "SHELF" },
      { id: "bk2", branch_id: "b2", state: "LOST" }, // exists only as a Book, only in b2
    ],
    Loan: [
      { id: "l1", branch_id: "b1", member_id: "m2", book_id: "bk1", state: "OPEN", due_at: null, renewals: 0 },
      { id: "l2", branch_id: "b1", member_id: "m2", book_id: "bk1", state: "OPEN", due_at: NOW + DAY_MS, renewals: 1 },
      { id: "l3", branch_id: "b1", member_id: "ghost", book_id: "bk1", state: "CLOSED", due_at: NOW - DAY_MS, renewals: 2 },
      { id: "l4", branch_id: "b1", member_id: "m1", book_id: "bk1", state: "OPEN", due_at: NOW + DAY_MS, renewals: 0 },
    ],
  },
  links: {
    book_author: [
      { from: "bk1", to: "p1", branch_id: "b1" },
      { from: "bk2", to: "p1", branch_id: "b2" },
    ],
  },
};

const staff: Actor = { id: "u1", keys: ["loan.create", "fee.waive", "fee.waive.large", "member.invite", "branch.admin"], kind: "user" };
const nobody: Actor = { id: "u0", keys: [], kind: "user" };

// Every decide result goes through here, so the last test can check that none is an envelope result.
const seen: DecideResult[] = [];
const run = (action: string, bindings: Bindings, actor: Actor = staff, scope: string | null = "b1", ont: Stage1Ontology = base, snap: Snapshot = snapshot): DecideResult => {
  const r = decide(ont, action, snap, scope, bindings, actor, NOW);
  seen.push(r);
  return r;
};

const env = (bindings: Bindings, scope: string | null = "b1", actor: Actor = staff) => ({ action: "probe", snapshot, scope, bindings, actor, now: NOW });
const pred = (e: Expr, bindings: Bindings = {}, scope: string | null = "b1", actor: Actor = staff) => evalPredicate(base, e, env(bindings, scope, actor));
const val = (e: Expr, bindings: Bindings = {}) => evalValue(base, e, env(bindings));

type TV = "T" | "F" | "U";
const operand: Record<TV, number | null> = { T: 1, F: 2, U: null };
const P = eq(ref("p"), lit(1));
const Q = eq(ref("q"), lit(1));

// ---------- tests ----------
describe("Kleene logic", () => {
  const AND: Record<TV, Record<TV, TV>> = { T: { T: "T", F: "F", U: "U" }, F: { T: "F", F: "F", U: "F" }, U: { T: "U", F: "F", U: "U" } };
  const OR: Record<TV, Record<TV, TV>> = { T: { T: "T", F: "T", U: "T" }, F: { T: "T", F: "F", U: "U" }, U: { T: "T", F: "U", U: "U" } };
  const NOT: Record<TV, TV> = { T: "F", F: "T", U: "U" };
  for (const a of ["T", "F", "U"] as const)
    for (const b of ["T", "F", "U"] as const) {
      it(`and(${a}, ${b}) = ${AND[a][b]}`, () => expect(pred(and(P, Q), { p: operand[a], q: operand[b] })).toBe(AND[a][b]));
      it(`or(${a}, ${b}) = ${OR[a][b]}`, () => expect(pred(or(P, Q), { p: operand[a], q: operand[b] })).toBe(OR[a][b]));
    }
  for (const a of ["T", "F", "U"] as const) it(`not(${a}) = ${NOT[a]}`, () => expect(pred(not(P), { p: operand[a] })).toBe(NOT[a]));
});

describe("null and UNKNOWN (corpus item 6)", () => {
  it("eq on a null optional enum is U", () => expect(pred(eq(ref("e"), lit("A")), { e: null })).toBe("U"));
  it("not(U) is U", () => expect(pred(not(eq(ref("e"), lit("A"))), { e: null })).toBe("U"));
  it("isNull(null) is T", () => expect(pred(isNull(ref("e")), { e: null })).toBe("T"));
  it("on U, the fails row matches and the passes row does not", () =>
    expect(run("hold", { e: null })).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: 1 }));
  it("on T, the passes row matches", () => expect(run("hold", { e: "A" })).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 }));
});

describe("quantifiers", () => {
  const loansOf = nav("m", "loan_member", "reverse");
  const overdue = lt(ref("l.due_at"), ref("now"));
  it("empty collection: exists = F, all = T, none = T", () => {
    expect(pred(exists("l", loansOf, overdue), { m: "m4" })).toBe("F");
    expect(pred(all("l", loansOf, overdue), { m: "m4" })).toBe("T");
    expect(pred(none("l", loansOf, overdue), { m: "m4" })).toBe("T");
  });
  it("elements with only F and U: exists = F, all = F, none = T", () => {
    // m2 has l1 (due_at null -> U) and l2 (due tomorrow -> F).
    expect(pred(exists("l", loansOf, overdue), { m: "m2" })).toBe("F");
    expect(pred(all("l", loansOf, overdue), { m: "m2" })).toBe("F");
    expect(pred(none("l", loansOf, overdue), { m: "m2" })).toBe("T");
  });
  it("an omitted where counts as T", () => expect(pred(exists("l", loansOf), { m: "m2" })).toBe("T"));
});

describe("integer", () => {
  it("lt(p, 2): p = 1 -> T", () => expect(pred(lt(ref("p"), lit(2)), { p: 1 })).toBe("T"));
  it("lt(p, 2): p = 3 -> F", () => expect(pred(lt(ref("p"), lit(2)), { p: 3 })).toBe("F"));
  it("lt(p, 2): p = null -> U", () => expect(pred(lt(ref("p"), lit(2)), { p: null })).toBe("U"));
});

describe("sets", () => {
  it("in(x, actor.keys) is T when the key is held, F when not", () => {
    expect(pred(inSet(lit("loan.create"), ref("actor.keys")))).toBe("T");
    expect(pred(inSet(lit("loan.delete"), ref("actor.keys")))).toBe("F");
  });
  it("subsetOf(param, actor.keys) is T when every element is held, F when one is not", () => {
    expect(pred(subsetOf(ref("ks"), ref("actor.keys")), { ks: ["fee.waive", "loan.create"] })).toBe("T");
    expect(pred(subsetOf(ref("ks"), ref("actor.keys")), { ks: ["fee.waive", "loan.delete"] })).toBe("F");
  });
  it("subsetOf with a set literal on one side", () => {
    expect(pred(subsetOf(ref("ks"), lit(["a", "b", "c"])), { ks: ["b", "a"] })).toBe("T");
    expect(pred(subsetOf(ref("ks"), lit(["a", "b"])), { ks: ["a", "z"] })).toBe("F");
  });
  it("in with an enum element and a set literal", () => {
    expect(pred(inSet(ref("e"), lit(["A", "B"])), { e: "B" })).toBe("T");
    expect(pred(inSet(ref("e"), lit(["A", "B"])), { e: "C" })).toBe("F");
  });
  it("a null operand of in or subsetOf gives U", () => {
    expect(pred(inSet(ref("e"), lit(["A", "B"])), { e: null })).toBe("U");
    expect(pred(inSet(lit("loan.create"), ref("ks")), { ks: null })).toBe("U");
    expect(pred(subsetOf(ref("ks"), ref("actor.keys")), { ks: null })).toBe("U");
    expect(pred(subsetOf(lit(["a"]), ref("ks")), { ks: null })).toBe("U");
  });
});

describe("time", () => {
  it("plus(timestamp, duration) adds seconds", () =>
    expect(val(plus(ref("t"), ref("d")), { t: Date.UTC(2026, 2, 7, 12), d: 86400 })).toBe(Date.UTC(2026, 2, 8, 12)));
  it("dateIn after the spring-forward switch", () =>
    expect(val(dateIn(ref("t"), ref("tz")), { t: Date.UTC(2026, 2, 9, 6, 30), tz: "America/Los_Angeles" })).toBe("2026-03-08"));
  it("dateIn before the spring-forward switch", () =>
    expect(val(dateIn(ref("t"), ref("tz")), { t: Date.UTC(2026, 2, 8, 7, 30), tz: "America/Los_Angeles" })).toBe("2026-03-07"));
  it("dateIn in UTC", () => expect(val(dateIn(ref("t"), ref("tz")), { t: Date.UTC(2026, 2, 8, 7, 30), tz: "UTC" })).toBe("2026-03-08"));
  it("plus and dateIn with a null operand are null, and comparing them is U", () => {
    expect(val(plus(ref("t"), ref("d")), { t: null, d: 60 })).toBeNull();
    expect(val(dateIn(ref("t"), ref("tz")), { t: null, tz: "UTC" })).toBeNull();
    expect(pred(lt(plus(ref("t"), ref("d")), ref("now")), { t: null, d: 60 })).toBe("U");
    expect(pred(eq(dateIn(ref("t"), ref("tz")), lit("2026-03-08")), { t: null, tz: "UTC" })).toBe("U");
  });
});

describe("derived properties", () => {
  it("a non-Boolean derived value is evaluated through self", () => {
    expect(val(derived("member_standing", "m"), { m: "m2" })).toBe("GOOD");
    expect(pred(eq(derived("member_standing", "m"), lit("GOOD")), { m: "m2" })).toBe("T");
  });
  it("of a null optional ref: the value is null and a comparison is U", () => {
    expect(val(derived("member_standing", "m"), { m: null })).toBeNull();
    expect(pred(eq(derived("member_standing", "m"), lit("GOOD")), { m: null })).toBe("U");
  });
});

describe("undefined derived property and unspecified condition", () => {
  it("a matched row 0 hides an undefined derived property in row 1", () =>
    expect(run("renew", { loan: "l3" })).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: 0 }));
  it("reaching row 1 that reads an undefined derived property is INDETERMINATE with the derived id", () =>
    expect(run("renew", { loan: "l1" })).toStrictEqual({ layer: "indeterminate", reason: "unspecified", row: 1, condition: "risky", derived: "loan_risk" }));
  it("and(F, isNull(<undefined derived>)) is still INDETERMINATE (no short circuit)", () =>
    expect(run("renew_guarded", { loan: "l1" })).toStrictEqual({ layer: "indeterminate", reason: "unspecified", row: 0, condition: "guarded", derived: "loan_risk" }));
  it("a matched row 0 hides an unspecified condition in row 1 (corpus item 9)", () =>
    expect(run("renew_vague", { loan: "l3" })).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: 0 }));
  it("reaching an unspecified condition in row 1 is INDETERMINATE without a derived id (corpus item 9)", () => {
    const r = run("renew_vague", { loan: "l1" });
    expect(r).toStrictEqual({ layer: "indeterminate", reason: "unspecified", row: 1, condition: "vague" });
    expect(r).not.toHaveProperty("derived");
  });
});

describe("null optional ref and broken foreign keys", () => {
  it("a null optional ref parameter binds", () =>
    expect(run("checkout", { member: "m1", book: "bk1", sponsor: null })).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" }));
  it("an absent optional ref parameter binds as null", () =>
    expect(run("checkout", { member: "m1", book: "bk1" })).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" }));
  it("a bound optional ref is read; next is passed through", () =>
    expect(run("checkout", { member: "m1", book: "bk1", sponsor: "m2" })).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 1, next: { actions: ["confirm"] } }));
  it("a property of a null optional ref is null, so a comparison is U", () => expect(pred(eq(ref("m.state"), lit("GOOD")), { m: null })).toBe("U"));
  it("navigation from a null optional ref is the empty set: exists = F, all = T", () => {
    const loansOf = nav("m", "loan_member", "reverse");
    expect(pred(exists("l", loansOf), { m: null })).toBe("F");
    expect(pred(all("l", loansOf, eq(ref("l.state"), lit("OPEN"))), { m: null })).toBe("T");
  });
  it("a foreign key to a missing row navigates to the empty set, without a throw", () => {
    expect(pred(exists("x", nav("loan", "loan_member", "forward")), { loan: "l3" })).toBe("F");
    expect(pred(all("x", nav("loan", "loan_member", "forward"), eq(ref("x.state"), lit("GOOD"))), { loan: "l3" })).toBe("T");
  });
  it("a null foreign key navigates to the empty set", () => expect(pred(exists("x", nav("m", "member_person", "forward")), { m: "m4" })).toBe("F"));
  it("a foreign key to a present row navigates to it", () => {
    expect(pred(exists("x", nav("loan", "loan_member", "forward"), eq(ref("x.state"), lit("GOOD"))), { loan: "l1" })).toBe("T");
    expect(pred(exists("x", nav("loan", "loan_book", "forward"), eq(ref("x.state"), lit("SHELF"))), { loan: "l1" })).toBe("T");
  });
});

describe("scope filters by object type (corpus item 7)", () => {
  const membersOf = nav("person", "member_person", "reverse");
  const booksOf = nav("person", "book_author", "reverse");
  it("reverse navigation from a global Person reaches only Members of the current branch", () => {
    // p1 has Member m1 in b1 (GOOD) and a Member with the same id m1 in b2 (BANNED).
    expect(pred(all("x", membersOf, eq(ref("x.state"), lit("GOOD"))), { person: "p1" }, "b1")).toBe("T");
    expect(pred(exists("x", membersOf, eq(ref("x.state"), lit("BANNED"))), { person: "p1" }, "b1")).toBe("F");
    expect(pred(all("x", membersOf, eq(ref("x.state"), lit("BANNED"))), { person: "p1" }, "b2")).toBe("T");
    expect(pred(exists("x", membersOf, eq(ref("x.state"), lit("GOOD"))), { person: "p1" }, "b2")).toBe("F");
  });
  it("a pure link with branch_id reaches only rows of the current branch", () => {
    expect(pred(exists("x", booksOf, eq(ref("x.state"), lit("SHELF"))), { person: "p1" }, "b1")).toBe("T");
    expect(pred(exists("x", booksOf, eq(ref("x.state"), lit("LOST"))), { person: "p1" }, "b1")).toBe("F");
    expect(pred(exists("x", booksOf, eq(ref("x.state"), lit("LOST"))), { person: "p1" }, "b2")).toBe("T");
    expect(pred(exists("x", booksOf, eq(ref("x.state"), lit("SHELF"))), { person: "p1" }, "b2")).toBe("F");
  });
  it("a property read on a bound tenant object uses the row of the current branch", () => {
    expect(pred(eq(ref("m.state"), lit("GOOD")), { m: "m1" }, "b1")).toBe("T");
    expect(pred(eq(ref("m.state"), lit("BANNED")), { m: "m1" }, "b2")).toBe("T");
  });
});

describe("binding and scope (corpus item 10)", () => {
  it("a Member id of another branch is SCOPE_DENIED", () =>
    expect(run("checkout", { member: "m3", book: "bk1" })).toEqual({ layer: "invocation", result: "SCOPE_DENIED", param: "member" }));
  it("a missing id is INVALID_BINDING/not_found", () =>
    expect(run("checkout", { member: "nope", book: "bk1" })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "not_found" }));
  it("externalResult does not reveal existence in another branch", () => {
    const denied = run("checkout", { member: "m3", book: "bk1" });
    const missing = run("checkout", { member: "nope", book: "bk1" });
    if (denied.layer === "indeterminate" || missing.layer === "indeterminate") throw new Error("unexpected INDETERMINATE");
    expect(externalResult(denied)).toEqual(externalResult(missing));
    expect(externalResult(denied)).toEqual({ result: "INVALID_BINDING", param: "member", reason: "not_found" });
  });
  it("a root Branch parameter with another branch id is SCOPE_DENIED", () =>
    expect(run("register", { member: "m1", branch: "b2", at: NOW, day: "2026-03-08", tz: "UTC", ks: [], n: 1 })).toEqual({
      layer: "invocation",
      result: "SCOPE_DENIED",
      param: "branch",
    }));
  it("an id that exists only as a Book, in another branch, is not_found for a Member parameter", () =>
    expect(run("checkout", { member: "bk2", book: "bk1" })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "not_found" }));
  it("an id that exists only as a Book, in this branch, is not_found for a Member parameter", () =>
    expect(run("checkout", { member: "bk1", book: "bk1" })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "not_found" }));
  it("externalResult of other results", () => {
    expect(externalResult({ layer: "invocation", result: "PERMISSION_DENIED" })).toEqual({ result: "PERMISSION_DENIED" });
    expect(externalResult({ layer: "invocation", result: "INVALID_BINDING", param: "at", reason: "type" })).toEqual({ result: "INVALID_BINDING", param: "at", reason: "type" });
    expect(externalResult({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" })).toEqual({ result: "LENT" });
  });
});

describe("shape", () => {
  const ok = { member: "m1", branch: "b1", at: NOW, day: "2026-03-08", tz: "America/Los_Angeles", ks: ["a"], n: 3 };
  const bad = (param: string, reason: string) => ({ layer: "invocation", result: "INVALID_BINDING", param, reason });
  it("valid bindings pass", () => expect(run("register", ok)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" }));
  it("an undeclared parameter is unknown_param", () => expect(run("register", { ...ok, zeta: 1, extra: "x" })).toEqual(bad("extra", "unknown_param")));
  it("a missing required parameter is missing", () => {
    const { at: _at, ...rest } = ok;
    expect(run("register", rest)).toEqual(bad("at", "missing"));
  });
  it("a null required parameter is missing", () => expect(run("register", { ...ok, member: null })).toEqual(bad("member", "missing")));
  it("a timestamp given as a string is type", () => expect(run("register", { ...ok, at: "2026-03-08T00:00:00Z" })).toEqual(bad("at", "type")));
  it("a ref given as a number is type", () => expect(run("register", { ...ok, member: 7 })).toEqual(bad("member", "type")));
  it("a date not in YYYY-MM-DD form is type", () => expect(run("register", { ...ok, day: "2026-3-8" })).toEqual(bad("day", "type")));
  it("an unknown timezone is type", () => expect(run("register", { ...ok, tz: "Not/AZone" })).toEqual(bad("tz", "type")));
  it("a set given as a non-array is type", () => expect(run("register", { ...ok, ks: "a" })).toEqual(bad("ks", "type")));
  describe("an enum parameter with values", () => {
    const valued = structuredClone(base);
    valued.actionTypes.register.parameters!.mode = { type: "enum", values: ["A", "B"], optional: true };
    const ctx = { action: "register", locals: {} };
    it("a value not among the values is type", () => expect(run("register", { ...ok, mode: "C" }, staff, "b1", valued)).toEqual(bad("mode", "type")));
    it("a value among the values passes", () =>
      expect(run("register", { ...ok, mode: "A" }, staff, "b1", valued)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" }));
    it("an omitted optional valued parameter passes", () =>
      expect(run("register", ok, staff, "b1", valued)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" }));
    it("a value that does not fit enum is type", () => expect(run("register", { ...ok, mode: 7 }, staff, "b1", valued)).toEqual(bad("mode", "type")));
    it("parameters are checked in declaration order", () =>
      expect(run("register", { ...ok, at: "x", mode: "C" }, staff, "b1", valued)).toEqual(bad("at", "type")));
    it("a literal compared with the parameter must be among its values", () => {
      const msg = /is not one of the values of parameter mode/;
      expect(() => checkPredicate(valued, eq(ref("mode"), lit("C")), ctx)).toThrow(ExprError);
      expect(() => checkPredicate(valued, eq(ref("mode"), lit("C")), ctx)).toThrow(msg);
      expect(() => checkPredicate(valued, eq(lit("C"), ref("mode")), ctx)).toThrow(msg);
      expect(() => checkPredicate(valued, { neq: [ref("mode"), lit("C")] }, ctx)).toThrow(msg);
      expect(() => checkPredicate(valued, inSet(ref("mode"), lit(["A", "C"])), ctx)).toThrow(ExprError);
      expect(() => checkPredicate(valued, inSet(ref("mode"), lit(["A", "C"])), ctx)).toThrow(msg);
      expect(() => checkPredicate(valued, eq(ref("mode"), lit("B")), ctx)).not.toThrow();
    });
    it("values that are not a list (unchecked ontology) are not used for a substring match", () => {
      const stringy = structuredClone(base);
      stringy.actionTypes.register.parameters!.mode = { type: "enum", values: "A,B" as unknown as string[], optional: true };
      expect(run("register", { ...ok, mode: "B," }, staff, "b1", stringy)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" });
    });
  });
});

describe("evaluation order", () => {
  it("shape before permission: missing required parameter and no keys -> missing", () =>
    expect(run("checkout", { book: "bk1" }, nobody)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "missing" }));
  it("permission before binding: missing id and no keys -> PERMISSION_DENIED", () =>
    expect(run("checkout", { member: "nope", book: "bk1" }, nobody)).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
  it("permission before scope: other-branch id and no keys -> PERMISSION_DENIED", () =>
    expect(run("checkout", { member: "m3", book: "bk1" }, nobody)).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
});

describe("permission", () => {
  const passed = { layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" };
  const who = (keys: string[], kind = "user"): Actor => ({ id: "u9", keys, kind });
  it("a missing unconditional key is PERMISSION_DENIED, even when a conditional key is also missing", () =>
    expect(run("waive", { member: "m1" }, who(["loan.create"]))).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
  it("all keys and all conditional keys pass", () => expect(run("waive", { member: "m1" }, who(["fee.waive", "fee.waive.large"]))).toEqual(passed));
  it("only a conditional key missing is INDETERMINATE/permission_condition", () =>
    expect(run("waive", { member: "m1" }, who(["fee.waive"]))).toEqual({ layer: "indeterminate", reason: "permission_condition" }));
  it("permission_condition stops before binding", () =>
    expect(run("waive", { member: "nope" }, who(["fee.waive"]))).toEqual({ layer: "indeterminate", reason: "permission_condition" }));
  it("unknown permission is INDETERMINATE/permission_unknown", () =>
    expect(run("audit", {}, who([]))).toEqual({ layer: "indeterminate", reason: "permission_unknown" }));
  it("any_of passes when one alternative passes", () => expect(run("transfer", {}, who(["transfer.out"]))).toEqual(passed));
  it("any_of with every alternative denied is PERMISSION_DENIED", () =>
    expect(run("transfer", {}, who(["loan.create"]))).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
  it("a principals restriction denies another actor kind, even with all keys", () =>
    expect(run("invite", {}, who(["member.invite"], "service"))).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
  it("a principals restriction passes the listed actor kind", () => expect(run("invite", {}, who(["member.invite"], "user"))).toEqual(passed));
  it("any_of passes through another alternative without principals", () => {
    expect(run("invite_any", {}, who(["member.invite"], "service"))).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" });
    expect(run("invite_any", {}, who(["member.invite", "branch.admin"], "service"))).toEqual(passed);
  });
  it("{none} passes any actor", () => expect(run("hold", { e: "A" }, who([], "service"))).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 }));
  const kindOnly: Stage1Ontology = {
    ...base,
    actionTypes: { ...base.actionTypes, hold_user: { ...base.actionTypes.hold, permission: { none: "anyone", principals: { kinds: ["user"] } } } },
  };
  it("{none} with principals denies another actor kind", () =>
    expect(run("hold_user", { e: "A" }, who([], "service"), "b1", kindOnly)).toEqual({ layer: "invocation", result: "PERMISSION_DENIED" }));
  it("{none} with principals passes the listed actor kind", () =>
    expect(run("hold_user", { e: "A" }, who([], "user"), "b1", kindOnly)).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 }));
  it("{none} with principals: shape is checked before permission", () =>
    expect(run("hold_user", { e: 7 }, who([], "service"), "b1", kindOnly)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "e", reason: "type" }));
});

describe("decision table", () => {
  it("no decision table is INDETERMINATE/no_decision_table", () => expect(run("probe", {})).toEqual({ layer: "indeterminate", reason: "no_decision_table" }));
  it("no otherwise and no row matched is INDETERMINATE/no_row_matched", () =>
    expect(run("strict", { e: "B" })).toEqual({ layer: "indeterminate", reason: "no_row_matched" }));
  it("otherwise gives row: otherwise, with class from dispositions", () =>
    expect(run("checkout", { member: "m2", book: "bk1" })).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" }));
  it("a matched fails row takes its class from dispositions", () =>
    expect(run("checkout", { member: "m1", book: "bk2" }, staff, "b2")).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: 0 }));
  it("a result missing from dispositions throws", () => {
    const ont: Stage1Ontology = { ...base, dispositions: { ...base.dispositions } };
    delete ont.dispositions!.LENT;
    expect(() => decide(ont, "checkout", snapshot, "b1", { member: "m2", book: "bk1" }, staff, NOW)).toThrow();
  });
});

describe("no scope declared", () => {
  const { scope: _scope, ...unscoped } = base;
  it("a row with branch_id b2 binds under scope null, never SCOPE_DENIED", () => {
    const snap: Snapshot = { objects: { ...snapshot.objects, Member: [{ id: "m9", branch_id: "b2", person_id: "p1", state: "GOOD" }] } };
    expect(run("checkout", { member: "m9", book: "bk1" }, staff, null, unscoped, snap)).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" });
  });
  it("a non-null scope without a declared scope throws", () =>
    expect(() => decide(unscoped, "checkout", snapshot, "b1", { member: "m2", book: "bk1" }, staff, NOW)).toThrow());
  it("a null scope with a declared scope throws", () => expect(() => decide(base, "checkout", snapshot, null, { member: "m2", book: "bk1" }, staff, NOW)).toThrow());
});

describe("input errors throw", () => {
  const call = (ont: Stage1Ontology, action: string, bindings: Bindings, snap: Snapshot = snapshot) => () => decide(ont, action, snap, "b1", bindings, staff, NOW);
  const withCondition = (expr: Expr): Stage1Ontology => ({
    ...base,
    actionTypes: {
      ...base.actionTypes,
      bad: {
        parameters: { loan: { type: { ref: "Loan" } }, ks: { type: { set: "string" } } },
        permission: { none: "anyone" },
        conditions: [{ id: "c", expr }],
        decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "NOTED" }] },
      },
    },
  });
  const badBindings = { loan: "l1", ks: ["a"] };
  it("a duplicate id within one branch of one type", () => {
    const snap: Snapshot = { objects: { ...snapshot.objects, Member: [...snapshot.objects.Member!, { id: "m1", branch_id: "b1", person_id: "p2", state: "GOOD" }] } };
    expect(call(base, "checkout", { member: "m1", book: "bk1" }, snap)).toThrow();
  });
  it("an unknown action", () => expect(call(base, "nope", {})).toThrow());
  it("a parameter without type", () => {
    const ont: Stage1Ontology = { ...base, actionTypes: { ...base.actionTypes, untyped: { parameters: { x: {} }, permission: { none: "anyone" }, conditions: [], decision: otherwiseNoted } } };
    expect(call(ont, "untyped", { x: "a" })).toThrow();
  });
  it("a type listed in both global and root", () => {
    const ont: Stage1Ontology = { ...base, scope: { by: "branch_id", global: [{ type: "Person" }, { type: "Branch" }], root: { type: "Branch" } } };
    expect(call(ont, "hold", { e: "A" })).toThrow();
  });
  it("eq with two literals is an ExprError", () => expect(call(withCondition(eq(lit(1), lit(1))), "bad", badBindings)).toThrow(ExprError));
  it("lt on an enum is an ExprError", () => expect(call(withCondition(lt(ref("loan.state"), lit("A"))), "bad", badBindings)).toThrow(ExprError));
  it("eq on two sets is an ExprError", () => expect(call(withCondition(eq(ref("ks"), ref("actor.keys"))), "bad", badBindings)).toThrow(ExprError));
  it("a derived property read as {ref: x.<derived id>} is an ExprError", () => {
    // Loan also declares a typed property with the derived id, so only the derived-property rule can reject the read.
    const withProp = withCondition(eq(ref("loan.loan_risk"), lit("HIGH")));
    const ont: Stage1Ontology = { ...withProp, objectTypes: { ...withProp.objectTypes, Loan: { ...withProp.objectTypes.Loan!, properties: { ...withProp.objectTypes.Loan!.properties, loan_risk: { type: "enum" } } } } };
    expect(call(ont, "bad", badBindings)).toThrow(ExprError);
    expect(call(ont, "bad", badBindings)).toThrow(/is a derived property/);
  });
  it("checkPredicate rejects the same expressions directly", () => {
    const ctx = { action: "bad", locals: {} };
    const ont = withCondition(eq(ref("loan.state"), lit("OPEN")));
    expect(() => checkPredicate(ont, eq(ref("loan.state"), lit("OPEN")), ctx)).not.toThrow();
    expect(() => checkPredicate(ont, eq(lit(1), lit(1)), ctx)).toThrow(ExprError);
    expect(() => checkPredicate(ont, lt(ref("loan.state"), lit("A")), ctx)).toThrow(ExprError);
    expect(() => checkPredicate(ont, eq(ref("ks"), ref("actor.keys")), ctx)).toThrow(ExprError);
    expect(() => checkPredicate(ont, eq(ref("loan.loan_risk"), lit("HIGH")), ctx)).toThrow(ExprError);
  });
});

describe("set-of-ref parameters bind each element", () => {
  const checkout = (others: string[]) => run("checkout", { member: "m2", book: "bk1", others });
  it("an element of another branch is SCOPE_DENIED", () => expect(checkout(["m1", "m3"])).toEqual({ layer: "invocation", result: "SCOPE_DENIED", param: "others" }));
  it("a nonexistent element is INVALID_BINDING/not_found", () =>
    expect(checkout(["m1", "nope"])).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "others", reason: "not_found" }));
  it("an element that exists only as a Book is not_found", () =>
    expect(checkout(["bk1"])).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "others", reason: "not_found" }));
  it("the first failing element in array order decides", () => {
    expect(checkout(["m3", "nope"])).toEqual({ layer: "invocation", result: "SCOPE_DENIED", param: "others" });
    expect(checkout(["nope", "m3"])).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "others", reason: "not_found" });
  });
  it("externalResult does not reveal an element's existence in another branch", () => {
    const denied = checkout(["m3"]);
    const missing = checkout(["nope"]);
    if (denied.layer === "indeterminate" || missing.layer === "indeterminate") throw new Error("unexpected INDETERMINATE");
    expect(externalResult(denied)).toEqual(externalResult(missing));
  });
  it("all elements valid (and the empty set) bind", () => {
    expect(checkout(["m1", "m2"])).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" });
    expect(checkout([])).toEqual({ layer: "domain", result: "LENT", class: "applied", row: "otherwise" });
  });
});

describe("an incomplete snapshot throws", () => {
  it("a tenant row without its scope field", () => {
    const snap: Snapshot = { objects: { ...snapshot.objects, Member: [...snapshot.objects.Member!, { id: "m8", person_id: "p1", state: "GOOD" }] } };
    expect(() => decide(base, "checkout", snap, "b1", { member: "m2", book: "bk1" }, staff, NOW)).toThrow(/has no branch_id/);
  });
  it("a pure link row with a tenant end, without its scope field", () => {
    const snap: Snapshot = { ...snapshot, links: { book_author: [...snapshot.links!.book_author!, { from: "bk1", to: "p2" }] } };
    const e = { action: "probe", snapshot: snap, scope: "b1", bindings: { person: "p1" }, actor: staff, now: NOW };
    expect(() => evalPredicate(base, exists("x", nav("person", "book_author", "reverse")), e)).toThrow(/has no branch_id/);
  });
});

describe("names are own keys, never prototype members", () => {
  it("an undeclared constructor binding is unknown_param", () =>
    expect(run("hold", { e: "A", constructor: "x" })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "constructor", reason: "unknown_param" }));
  it("a parameter named toString is read as that parameter", () => {
    const ont: Stage1Ontology = {
      ...base,
      actionTypes: {
        ...base.actionTypes,
        odd: {
          parameters: { toString: { type: "enum" as const, optional: true as const } },
          permission: { none: "anyone" },
          conditions: [{ id: "is_a", expr: eq(ref("toString"), lit("A")) }],
          decision: { hitPolicy: "first", rows: [{ when: { passes: "is_a" }, result: "HELD" }], otherwise: { result: "NOTED" } },
        },
      },
    };
    expect(run("odd", { toString: "A" }, staff, "b1", ont)).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 });
    expect(run("odd", {}, staff, "b1", ont)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" });
  });
});

describe("more input errors throw up front", () => {
  const withAction = (a: Stage1Ontology["actionTypes"][string]): Stage1Ontology => ({ ...base, actionTypes: { ...base.actionTypes, x: a } });
  it("a decision row naming an unknown condition throws, even when an earlier row matches", () => {
    const ont = withAction({ ...base.actionTypes.hold!, decision: { hitPolicy: "first", rows: [{ when: { passes: "is_a" }, result: "HELD" }, { when: { fails: "nope" }, result: "REFUSED" }] } });
    expect(() => decide(ont, "x", snapshot, "b1", { e: "A" }, staff, NOW)).toThrow(/unknown condition nope/);
  });
  for (const name of ["now", "actor", "self"])
    it(`a parameter named ${name} throws`, () => {
      const ont = withAction({ parameters: { [name]: { type: "timestamp" as const, optional: true as const } }, permission: { none: "anyone" }, conditions: [], decision: otherwiseNoted });
      expect(() => decide(ont, "x", snapshot, "b1", {}, staff, NOW)).toThrow(/reserved name/);
    });
  it("reading an actor property other than id or keys throws", () => {
    expect(() => val(ref("actor.kind"))).toThrow(/actor\.kind/);
    expect(val(ref("actor.id"))).toBe("u1");
  });
});

describe("no short circuit, and undefined only when reached", () => {
  const withRenew = (expr: Expr, snap: Snapshot = snapshot, bindings: Bindings = { loan: "l1" }) => {
    const ont: Stage1Ontology = {
      ...base,
      actionTypes: {
        ...base.actionTypes,
        x: {
          parameters: { loan: { type: { ref: "Loan" } }, m: { type: { ref: "Member" }, optional: true } },
          permission: { none: "anyone" },
          conditions: [{ id: "c", expr }],
          decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "RENEWED" }], otherwise: { result: "NOTED" } },
        },
      },
    };
    return decide(ont, "x", snap, "b1", bindings, staff, NOW);
  };
  const undefinedAt = { layer: "indeterminate", reason: "unspecified", row: 0, condition: "c", derived: "loan_risk" };
  it("or(T, isNull(<undefined derived>)) is INDETERMINATE", () =>
    expect(withRenew(or(eq(ref("loan.state"), lit("OPEN")), isNull(derived("loan_risk", "loan"))))).toStrictEqual(undefinedAt));
  it("a quantifier whose where is or(T, <undefined derived>) is INDETERMINATE", () =>
    expect(withRenew(exists("l", nav("m", "loan_member", "reverse"), or(eq(ref("l.state"), lit("OPEN")), isNull(derived("loan_risk", "l")))), snapshot, { loan: "l1", m: "m2" })).toStrictEqual(undefinedAt));
  it("a quantifier evaluates every element, even after one gives T", () => {
    // Loans of bk1, with l3 first. l3 is CLOSED (T); its member is missing, so the inner where never runs and
    // nothing undefined is read. l1 is OPEN and has a member, so it reads loan_risk.
    const snap: Snapshot = { ...snapshot, objects: { ...snapshot.objects, Loan: [snapshot.objects.Loan![2]!, snapshot.objects.Loan![0]!] } };
    const ont: Stage1Ontology = { ...base, actionTypes: { ...base.actionTypes, x: { parameters: { book: { type: { ref: "Book" } } }, permission: { none: "anyone" }, conditions: [{ id: "c", expr: exists("l", nav("book", "loan_book", "reverse"), or(eq(ref("l.state"), lit("CLOSED")), exists("mm", nav("l", "loan_member", "forward"), isNull(derived("loan_risk", "l"))))) }], decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "RENEWED" }], otherwise: { result: "NOTED" } } } } };
    expect(decide(ont, "x", snap, "b1", { book: "bk1" }, staff, NOW)).toStrictEqual(undefinedAt);
  });
  it("an undefined derived property of a null optional ref is null, never reached", () => {
    expect(pred(isNull(derived("loan_risk", "loan")), { loan: null })).toBe("T");
    expect(() => pred(isNull(derived("loan_risk", "loan")), { loan: "l1" })).toThrow(UndefinedDerived);
  });
  it("an empty quantifier never evaluates its where", () =>
    expect(pred(exists("l", nav("m", "loan_member", "reverse"), isNull(derived("loan_risk", "l"))), { m: "m4" })).toBe("F"));
});

describe("static type rules", () => {
  const ctx = { action: "probe", locals: {} };
  const rejects = (e: Expr, msg: RegExp, ont: Stage1Ontology = base) => expect(() => checkPredicate(ont, e, ctx)).toThrow(msg);
  const accepts = (e: Expr, ont: Stage1Ontology = base) => expect(() => checkPredicate(ont, e, ctx)).not.toThrow();
  const loansOf = nav("m", "loan_member", "reverse");
  it("a quantifier variable may not take a reserved name", () => {
    rejects(exists("now", loansOf), /reserved name/);
    rejects(exists("self", loansOf), /reserved name/);
    accepts(exists("l", loansOf));
  });
  it("a quantifier variable may not take a parameter name", () => rejects(exists("loan", loansOf), /is a parameter name/));
  it("a quantifier variable may not reuse an outer variable", () =>
    rejects(exists("x", nav("loan", "loan_member", "forward"), exists("x", nav("x", "member_person", "forward"))), /outer quantifier/));
  it("self is valid only in a derived property expression", () => rejects(eq(ref("self.state"), lit("GOOD")), /self is valid only/));
  it("a derived expression must have the declared type", () => {
    const ont: Stage1Ontology = { ...base, derivedProperties: { ...base.derivedProperties, loan_risk: { of: "Loan", type: "timestamp", expr: ref("self.state") } } };
    rejects(isNull(derived("loan_risk", "loan")), /is not the declared/, ont);
    accepts(isNull(derived("loan_risk", "loan")), { ...base, derivedProperties: { ...base.derivedProperties, loan_risk: { of: "Loan", type: "enum", expr: ref("self.state") } } });
  });
  it("eq and neq reject sets", () => {
    rejects({ neq: [ref("ks"), lit(["a"])] }, /on a set/);
    rejects(eq(ref("ks"), ref("ks")), /on a set/);
  });
  it("an operation with two literal operands is an error", () => {
    rejects(eq(lit(1), lit(1)), /both operands are literals/);
    rejects(lt(plus(lit(0), lit(60)), ref("now")), /two literal operands/);
    accepts(lt(plus(ref("t"), lit(60)), ref("now")));
  });
  it("in rejects a literal element or set element of the wrong type", () => {
    rejects(inSet(lit(1), ref("actor.keys")), /does not fit/);
    rejects(inSet(ref("e"), lit([1, 2])), /does not fit/);
    accepts(inSet(lit("a"), ref("actor.keys")));
  });
  it("a set parameter with an element of the wrong type is INVALID_BINDING/type", () =>
    expect(run("register", { member: "m1", branch: "b1", at: NOW, day: "2026-03-08", tz: "UTC", ks: ["a", 1], n: 1 })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "ks", reason: "type" }));
  it("a foreign key to a row that exists only in another branch navigates to the empty set", () => {
    // m3 exists only in b2; l5 is in b1.
    const snap: Snapshot = { ...snapshot, objects: { ...snapshot.objects, Loan: [...snapshot.objects.Loan!, { id: "l5", branch_id: "b1", member_id: "m3", book_id: "bk1", state: "OPEN", due_at: null, renewals: 0 }] } };
    const e = { action: "probe", snapshot: snap, scope: "b1", bindings: { loan: "l5" }, actor: staff, now: NOW };
    expect(evalPredicate(base, exists("x", nav("loan", "loan_member", "forward")), e)).toBe("F");
    expect(evalPredicate(base, all("x", nav("loan", "loan_member", "forward"), eq(ref("x.state"), lit("GOOD"))), e)).toBe("T");
  });
});

describe("an invalid snapshot is never masked by an undefined derived property", () => {
  // loan_cost: a second Loan derived property without expr. member_flag: a Member derived property without expr.
  const ont = (expr: Expr): Stage1Ontology => ({
    ...base,
    // loan_due / loan_grace / loan_tz / loan_tags: Loan derived properties without expr, typed for the operands of plus,
    // dateIn, in and subsetOf. grace / tz / tags: Loan properties that no fixture row carries.
    objectTypes: {
      ...base.objectTypes,
      Loan: { ...base.objectTypes.Loan!, properties: { ...base.objectTypes.Loan!.properties, grace: { type: "duration" }, tz: { type: "timezone" }, tags: { type: { set: "enum" } } } },
    },
    derivedProperties: {
      ...base.derivedProperties,
      loan_cost: { of: "Loan", type: "enum" },
      member_flag: { of: "Member", type: "enum" },
      loan_due: { of: "Loan", type: "timestamp" },
      loan_grace: { of: "Loan", type: "duration" },
      loan_tz: { of: "Loan", type: "timezone" },
      loan_tags: { of: "Loan", type: { set: "enum" } },
    },
    actionTypes: {
      ...base.actionTypes,
      x: {
        parameters: { loan: { type: { ref: "Loan" } }, book: { type: { ref: "Book" } } },
        permission: { none: "anyone" },
        conditions: [{ id: "c", expr }],
        decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "RENEWED" }], otherwise: { result: "NOTED" } },
      },
    },
  });
  const withLoans = (loans: Row[]): Snapshot => ({ ...snapshot, objects: { ...snapshot.objects, Loan: loans } });
  const [l1, l2] = [snapshot.objects.Loan![0]!, snapshot.objects.Loan![1]!];
  const { renewals: _r, ...l1NoRenewals } = l1;
  const { member_id: _m, ...l2NoMember } = l2;
  const go = (expr: Expr, snap: Snapshot = snapshot) => decide(ont(expr), "x", snap, "b1", { loan: "l1", book: "bk1" }, staff, NOW);
  const undef = isNull(derived("loan_risk", "loan"));
  const broken = eq(ref("loan.renewals"), lit(0));
  for (const [name, op] of [["and", and], ["or", or]] as const)
    it(`${name}(<undefined derived>, <row missing a key>) throws in both orders`, () => {
      const snap = withLoans([l1NoRenewals, l2]);
      expect(() => go(op(undef, broken), snap)).toThrow(/has no renewals/);
      expect(() => go(op(broken, undef), snap)).toThrow(/has no renewals/);
    });
  it("eq(<undefined derived>, <row missing a key>) throws in both orders", () => {
    const { state: _s, ...l1NoState } = l1;
    const snap = withLoans([l1NoState, l2]);
    expect(() => go(eq(derived("loan_risk", "loan"), ref("loan.state")), snap)).toThrow(/has no state/);
    expect(() => go(eq(ref("loan.state"), derived("loan_risk", "loan")), snap)).toThrow(/has no state/);
  });
  it("plus(<undefined derived>, <row missing a key>) throws in both orders", () => {
    // Operand types are fixed (timestamp, duration), so each order uses its own derived property and missing key.
    expect(() => go(lt(plus(derived("loan_due", "loan"), ref("loan.grace")), ref("now")))).toThrow(/has no grace/);
    const { due_at: _d, ...l1NoDue } = l1;
    expect(() => go(lt(plus(ref("loan.due_at"), derived("loan_grace", "loan")), ref("now")), withLoans([l1NoDue, l2]))).toThrow(/has no due_at/);
  });
  it("dateIn(<undefined derived>, <row missing a key>) throws in both orders", () => {
    // Operand types are fixed (timestamp, timezone), so each order uses its own derived property and missing key.
    expect(() => go(eq(dateIn(derived("loan_due", "loan"), ref("loan.tz")), lit("2026-03-08")))).toThrow(/has no tz/);
    const { due_at: _d, ...l1NoDue } = l1;
    expect(() => go(eq(dateIn(ref("loan.due_at"), derived("loan_tz", "loan")), lit("2026-03-08")), withLoans([l1NoDue, l2]))).toThrow(/has no due_at/);
  });
  it("in(<undefined derived>, <row missing a key>) throws in both orders", () => {
    // Operand types are fixed (element, set), so each order uses its own derived property and missing key.
    expect(() => go(inSet(derived("loan_risk", "loan"), ref("loan.tags")))).toThrow(/has no tags/);
    const { state: _s, ...l1NoState } = l1;
    expect(() => go(inSet(ref("loan.state"), derived("loan_tags", "loan")), withLoans([l1NoState, l2]))).toThrow(/has no state/);
  });
  it("subsetOf(<undefined derived>, <row missing a key>) throws in both orders", () => {
    expect(() => go(subsetOf(derived("loan_tags", "loan"), ref("loan.tags")))).toThrow(/has no tags/);
    expect(() => go(subsetOf(ref("loan.tags"), derived("loan_tags", "loan")))).toThrow(/has no tags/);
  });
  it("a quantifier with one element reading an undefined derived and one element missing a key throws in both orders", () => {
    // Loans of bk1: l1's member m2 reads member_flag (undefined); l2 has no member_id.
    const e = exists("l", nav("book", "loan_book", "reverse"), exists("mm", nav("l", "loan_member", "forward"), isNull(derived("member_flag", "mm"))));
    expect(() => go(e, withLoans([l1, l2NoMember]))).toThrow(/has no member_id/);
    expect(() => go(e, withLoans([l2NoMember, l1]))).toThrow(/has no member_id/);
  });
  it("two undefined derived properties: the first in operand order is reported", () => {
    const at = (d: string) => ({ layer: "indeterminate", reason: "unspecified", row: 0, condition: "c", derived: d });
    expect(go(and(undef, isNull(derived("loan_cost", "loan"))))).toStrictEqual(at("loan_risk"));
    expect(go(and(isNull(derived("loan_cost", "loan")), undef))).toStrictEqual(at("loan_cost"));
  });
});

describe("more input checks", () => {
  const withAction = (a: Stage1Ontology["actionTypes"][string], extra: Partial<Stage1Ontology> = {}): Stage1Ontology => ({ ...base, ...extra, actionTypes: { ...base.actionTypes, x: a } });
  it("a decision row result or otherwise result missing from dispositions throws, even when an earlier row matches", () => {
    const rows = (r1: string) => [{ when: { passes: "is_a" }, result: "HELD" }, { when: { fails: "is_a" }, result: r1 }];
    const bad1 = withAction({ ...base.actionTypes.hold!, decision: { hitPolicy: "first", rows: rows("NOPE") } });
    expect(() => decide(bad1, "x", snapshot, "b1", { e: "A" }, staff, NOW)).toThrow(/NOPE has no disposition/);
    const bad2 = withAction({ ...base.actionTypes.hold!, decision: { hitPolicy: "first", rows: rows("REFUSED"), otherwise: { result: "NOPE" } } });
    expect(() => decide(bad2, "x", snapshot, "b1", { e: "A" }, staff, NOW)).toThrow(/NOPE has no disposition/);
  });
  it("an object type or pure link named toString, absent from the snapshot, has no rows", () => {
    const ont = withAction(
      { parameters: { odd: { type: { ref: "toString" } }, book: { type: { ref: "Book" }, optional: true } }, permission: { none: "anyone" }, conditions: [], decision: otherwiseNoted },
      {
        objectTypes: { ...base.objectTypes, toString: { datasource: "odds", properties: {} } },
        linkTypes: [...base.linkTypes, { id: "toString", from: "Book", to: "Person", via: "person_id", table: "odd_links" }],
      },
    );
    expect(decide(ont, "x", snapshot, "b1", { odd: "o1" }, staff, NOW)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "odd", reason: "not_found" });
    const e = { action: "x", snapshot, scope: "b1", bindings: { odd: null, book: "bk1" }, actor: staff, now: NOW };
    expect(evalPredicate(ont, exists("p", nav("book", "toString", "forward")), e)).toBe("F");
  });
  it("a ref with more than one dot, or a property of now, throws", () => {
    expect(() => val(ref("now.x"))).toThrow(/now has no properties/);
    expect(() => val(ref("m.state.x"), { m: "m2" })).toThrow(/at most one dot/);
    expect(val(ref("m.state"), { m: "m2" })).toBe("GOOD");
  });
  it("a derived property expression cannot read the action's bindings", () => {
    const ont: Stage1Ontology = { ...base, derivedProperties: { ...base.derivedProperties, leak: { of: "Member", type: "enum", expr: ref("e") } } };
    expect(() => evalValue(ont, derived("leak", "m"), env({ m: "m2", e: "SECRET" }))).toThrow(/not visible in a derived/);
  });
  for (const name of ["now", "actor", "self"])
    it(`checkPredicate rejects an action whose parameter is named ${name}`, () => {
      const ont = withAction({ parameters: { [name]: { type: "timestamp" as const }, t: { type: "timestamp" as const } }, permission: { none: "anyone" }, conditions: [], decision: otherwiseNoted });
      expect(() => checkPredicate(ont, lt(ref("t"), ref("t")), { action: "x", locals: {} })).toThrow(/reserved name/);
    });
});

describe("parameters are checked in declaration order", () => {
  it("two ref parameters that fail binding: the first declared is reported, not the first by name", () =>
    expect(run("checkout", { member: "zz", book: "zz" })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "not_found" }));
  it("two missing required parameters: the first declared is reported", () =>
    expect(run("register", { branch: "b1", day: "2026-03-08", tz: "UTC", ks: [], n: 1 })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "member", reason: "missing" }));
  it("a set-of-ref parameter declared before a scalar ref parameter is reported first", () => {
    const ont: Stage1Ontology = {
      ...base,
      actionTypes: {
        ...base.actionTypes,
        x: { parameters: { others: { type: { set: { ref: "Member" } } }, member: { type: { ref: "Member" } } }, permission: { none: "anyone" }, conditions: [], decision: otherwiseNoted },
      },
    };
    expect(run("x", { others: ["zz"], member: "zz" }, staff, "b1", ont)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "others", reason: "not_found" });
  });
});

describe("boolean is an ordinary scalar type", () => {
  const openLoans = exists("l", nav("self", "loan_member", "reverse"), eq(ref("l.state"), lit("OPEN")));
  const boolOnt: Stage1Ontology = {
    ...base,
    objectTypes: { ...base.objectTypes, Member: { ...base.objectTypes.Member!, properties: { ...base.objectTypes.Member!.properties, vip: { type: "boolean" } } } },
    derivedProperties: {
      ...base.derivedProperties,
      // A Boolean derived property whose expression root is a quantifier.
      has_open_loan: { of: "Member", type: "boolean", expr: openLoans },
      // A Boolean derived property whose expression root is a comparison (U when due_at is null).
      overdue: { of: "Loan", type: "boolean", expr: lt(ref("self.due_at"), ref("now")) },
    },
    actionTypes: {
      ...base.actionTypes,
      flag: {
        parameters: {
          b: { type: "boolean", optional: true },
          c: { type: "boolean", optional: true },
          bs: { type: { set: "boolean" }, optional: true },
          e: { type: "enum", optional: true },
          m: { type: { ref: "Member" }, optional: true },
          loan: { type: { ref: "Loan" }, optional: true },
        },
        permission: { none: "anyone" },
        conditions: [],
      },
      flag_req: {
        parameters: { b: { type: "boolean" }, bs: { type: { set: "boolean" }, optional: true } },
        permission: { none: "anyone" },
        conditions: [{ id: "is_b", expr: ref("b") }],
        decision: { hitPolicy: "first", rows: [{ when: { passes: "is_b" }, result: "HELD" }], otherwise: { result: "NOTED" } },
      },
      idle: {
        parameters: { m: { type: { ref: "Member" } } },
        permission: { none: "anyone" },
        conditions: [{ id: "no_open_loan", expr: not(derived("has_open_loan", "m")) }],
        decision: { hitPolicy: "first", rows: [{ when: { passes: "no_open_loan" }, result: "LENT" }], otherwise: { result: "REFUSED" } },
      },
    },
  };
  const boolSnap: Snapshot = {
    ...snapshot,
    objects: {
      ...snapshot.objects,
      Member: [
        { id: "m1", branch_id: "b1", person_id: "p1", state: "GOOD", vip: true },
        { id: "m2", branch_id: "b1", person_id: "p2", state: "GOOD", vip: false },
        { id: "m4", branch_id: "b1", person_id: null, state: "LAPSED", vip: null },
      ],
    },
  };
  const benv = (bindings: Bindings) => ({ action: "flag", snapshot: boolSnap, scope: "b1", bindings, actor: staff, now: NOW });
  const bpred = (e: Expr, bindings: Bindings = {}) => evalPredicate(boolOnt, e, benv(bindings));
  const bval = (e: Expr, bindings: Bindings = {}) => evalValue(boolOnt, e, benv(bindings));
  const ctx = { action: "flag", locals: {} };
  const accepts = (e: unknown, ont: Stage1Ontology = boolOnt) => expect(() => checkPredicate(ont, e as Expr, ctx)).not.toThrow();
  const rejects = (e: unknown, ont: Stage1Ontology = boolOnt) => expect(() => checkPredicate(ont, e as Expr, ctx)).toThrow(ExprError);

  it("SCALAR_TYPE_NAMES lists boolean", () => expect(SCALAR_TYPE_NAMES).toContain("boolean"));
  it("a boolean parameter in predicate position: true -> T, false -> F, null -> U", () => {
    accepts(ref("b"));
    expect(bpred(ref("b"), { b: true })).toBe("T");
    expect(bpred(ref("b"), { b: false })).toBe("F");
    expect(bpred(ref("b"), { b: null })).toBe("U");
    expect(bpred(ref("b"), {})).toBe("U");
  });
  it("boolean values follow Kleene logic in and / or / not", () => {
    accepts(and(ref("b"), ref("c")));
    expect(bpred(and(ref("b"), ref("c")), { b: true, c: null })).toBe("U");
    expect(bpred(and(ref("b"), ref("c")), { b: false, c: null })).toBe("F");
    expect(bpred(or(ref("b"), ref("c")), { b: null, c: true })).toBe("T");
    expect(bpred(or(ref("b"), ref("c")), { b: null, c: false })).toBe("U");
    expect(bpred(not(ref("b")), { b: null })).toBe("U");
    expect(bpred(not(ref("b")), { b: false })).toBe("T");
    expect(bpred(and(ref("b"), eq(ref("e"), lit("A"))), { b: true, e: "A" })).toBe("T");
  });
  it("a boolean value in value position is true / false / null", () => {
    expect(bval(ref("b"), { b: true })).toBe(true);
    expect(bval(ref("b"), { b: null })).toBeNull();
  });
  it("eq and neq of two booleans follow the same-type rule", () => {
    accepts(eq(ref("b"), ref("c")));
    expect(bpred(eq(ref("b"), ref("c")), { b: true, c: true })).toBe("T");
    expect(bpred(eq(ref("b"), ref("c")), { b: true, c: false })).toBe("F");
    expect(bpred({ neq: [ref("b"), ref("c")] }, { b: true, c: false })).toBe("T");
    expect(bpred(eq(ref("b"), ref("c")), { b: null, c: false })).toBe("U");
    rejects(eq(ref("b"), ref("e")));
  });
  it("isNull and isNotNull work on a boolean value", () => {
    accepts(isNull(ref("b")));
    expect(bpred(isNull(ref("b")), { b: null })).toBe("T");
    expect(bpred(isNull(ref("b")), { b: false })).toBe("F");
    expect(bpred({ isNotNull: [ref("b")] }, { b: false })).toBe("T");
  });
  it("a boolean property in predicate position: true -> T, false -> F, null -> U", () => {
    accepts(ref("m.vip"));
    expect(bpred(ref("m.vip"), { m: "m1" })).toBe("T");
    expect(bpred(ref("m.vip"), { m: "m2" })).toBe("F");
    expect(bpred(ref("m.vip"), { m: "m4" })).toBe("U");
    expect(bpred(ref("m.vip"), { m: null })).toBe("U");
  });
  it("a value node of a non-boolean type in predicate position is still an ExprError", () => {
    rejects(ref("e"));
    rejects(ref("m.state"));
    rejects(derived("member_standing", "m"));
    rejects(not(ref("e")));
  });
  it("there are no boolean literals", () => {
    rejects({ lit: true });
    rejects(eq(ref("b"), { lit: true } as unknown as Expr));
    rejects(eq(ref("b"), lit("true")));
    rejects(eq(ref("b"), lit(1)));
  });
  it("not(<boolean derived with a quantifier root>) in predicate position", () => {
    accepts(not(derived("has_open_loan", "m")));
    // m2 has open loans l1 and l2; m1 has open loan l4; m4 has no loans.
    expect(bpred(derived("has_open_loan", "m"), { m: "m2" })).toBe("T");
    expect(bpred(not(derived("has_open_loan", "m")), { m: "m2" })).toBe("F");
    expect(bpred(not(derived("has_open_loan", "m")), { m: "m4" })).toBe("T");
    expect(bpred(not(derived("has_open_loan", "m")), { m: null })).toBe("U");
  });
  it("a boolean derived in a decision condition", () => {
    expect(run("idle", { m: "m4" }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "domain", result: "LENT", class: "applied", row: 0 });
    expect(run("idle", { m: "m2" }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "domain", result: "REFUSED", class: "rejected", row: "otherwise" });
  });
  it("evalValue of a boolean derived is true / false / null (U -> null)", () => {
    expect(bval(derived("has_open_loan", "m"), { m: "m2" })).toBe(true);
    expect(bval(derived("has_open_loan", "m"), { m: "m4" })).toBe(false);
    expect(bval(derived("overdue", "loan"), { loan: "l3" })).toBe(true);
    expect(bval(derived("overdue", "loan"), { loan: "l2" })).toBe(false);
    expect(bval(derived("overdue", "loan"), { loan: "l1" })).toBeNull();
    expect(bpred(derived("overdue", "loan"), { loan: "l1" })).toBe("U");
  });
  it("a boolean derived declared boolean with a comparison root is accepted", () => {
    accepts(derived("overdue", "loan"));
    accepts(eq(derived("overdue", "loan"), ref("b")));
  });
  it("a derived property with a predicate root declared enum is an ExprError", () => {
    const ont: Stage1Ontology = { ...boolOnt, derivedProperties: { ...boolOnt.derivedProperties, has_open_loan: { of: "Member", type: "enum", expr: openLoans } } };
    rejects(isNull(derived("has_open_loan", "m")), ont);
  });
  it("a derived property declared boolean with a boolean value root is an ExprError (its root must be a predicate)", () => {
    const ont: Stage1Ontology = { ...boolOnt, derivedProperties: { ...boolOnt.derivedProperties, is_vip: { of: "Member", type: "boolean", expr: ref("self.vip") } } };
    expect(() => checkPredicate(ont, derived("is_vip", "m"), ctx)).toThrow(/root must be a predicate/);
    rejects(isNull(derived("is_vip", "m")), ont);
  });
  it("a derived property declared boolean with a predicate root is accepted", () => {
    accepts(derived("has_open_loan", "m"));
    accepts(not(derived("overdue", "loan")));
  });
  it("a derived property declared boolean with a non-boolean value root is an ExprError", () => {
    const ont: Stage1Ontology = { ...boolOnt, derivedProperties: { ...boolOnt.derivedProperties, has_open_loan: { of: "Member", type: "boolean", expr: ref("self.state") } } };
    rejects(derived("has_open_loan", "m"), ont);
  });
  it("a set of boolean: in(b, bs), and a mixed array is INVALID_BINDING/type", () => {
    accepts(inSet(ref("b"), ref("bs")));
    expect(bpred(inSet(ref("b"), ref("bs")), { b: true, bs: [false, true] })).toBe("T");
    expect(bpred(inSet(ref("b"), ref("bs")), { b: true, bs: [false] })).toBe("F");
    expect(run("flag_req", { b: true, bs: [true, false] }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 });
    expect(run("flag_req", { b: true, bs: [true, "x"] }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "bs", reason: "type" });
  });
  it("a snapshot value that does not fit its declared type throws in every position", () => {
    const bad: Snapshot = { ...boolSnap, objects: { ...boolSnap.objects, Member: [{ id: "m1", branch_id: "b1", person_id: "p1", state: "GOOD", vip: 1 }] } };
    const e = { action: "flag", snapshot: bad, scope: "b1", bindings: { m: "m1" }, actor: staff, now: NOW };
    expect(() => evalPredicate(boolOnt, ref("m.vip"), e)).toThrow(/does not fit its declared type/);
    expect(() => evalValue(boolOnt, ref("m.vip"), e)).toThrow(/does not fit its declared type/);
    expect(() => evalPredicate(boolOnt, isNull(ref("m.vip")), e)).toThrow(/does not fit its declared type/);
    expect(() => evalPredicate(boolOnt, eq(ref("m.vip"), ref("b")), { ...e, bindings: { m: "m1", b: true } })).toThrow(/does not fit its declared type/);
  });
  it("shape: a boolean parameter accepts only true and false", () => {
    expect(run("flag_req", { b: true }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "domain", result: "HELD", class: "pending", row: 0 });
    expect(run("flag_req", { b: false }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" });
    const type = { layer: "invocation", result: "INVALID_BINDING", param: "b", reason: "type" };
    expect(run("flag_req", { b: "true" }, staff, "b1", boolOnt, boolSnap)).toEqual(type);
    expect(run("flag_req", { b: 1 }, staff, "b1", boolOnt, boolSnap)).toEqual(type);
    expect(run("flag_req", { b: 0 }, staff, "b1", boolOnt, boolSnap)).toEqual(type);
    expect(run("flag_req", { b: null }, staff, "b1", boolOnt, boolSnap)).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "b", reason: "missing" });
  });
});

describe("one format table for literals and parameters", () => {
  const ctx = { action: "probe", locals: {} };
  const accepts = (e: Expr) => expect(() => checkPredicate(base, e, ctx)).not.toThrow();
  const rejects = (e: Expr) => expect(() => checkPredicate(base, e, ctx)).toThrow(ExprError);
  const ok = { member: "m1", branch: "b1", at: NOW, day: "2026-03-08", tz: "America/Los_Angeles", ks: ["a"], n: 3 };
  const typeErr = (param: string) => ({ layer: "invocation", result: "INVALID_BINDING", param, reason: "type" });
  // Inclusive bounds with a one-day margin for every UTC offset, so dateIn gives a year from 1 to 9999.
  const MIN_TS = -62135510400000;
  const MAX_TS = 253402214399999;

  it("the timestamp bounds are 0001-01-02 and 9999-12-30 (UTC)", () => {
    expect(new Date(MIN_TS).toISOString()).toBe("0001-01-02T00:00:00.000Z");
    expect(new Date(MAX_TS).toISOString()).toBe("9999-12-30T23:59:59.999Z");
  });
  it("dateIn at the bounds stays within the years 1 and 9999, padded to 4 digits", () => {
    expect(val(dateIn(ref("t"), ref("tz")), { t: MIN_TS, tz: "America/Los_Angeles" })).toBe("0001-01-01");
    expect(val(dateIn(ref("t"), ref("tz")), { t: MAX_TS, tz: "Pacific/Kiritimati" })).toBe("9999-12-31");
  });
  it("dateIn of a timestamp outside the bounds throws (invalid input, not U)", () => {
    expect(() => val(dateIn(ref("t"), ref("tz")), { t: -7e13, tz: "UTC" })).toThrow(/timestamp out of supported range/);
    const e = { action: "probe", snapshot, scope: "b1", bindings: { tz: "UTC" }, actor: staff, now: 1e15 };
    expect(() => evalValue(base, dateIn(ref("now"), ref("tz")), e)).toThrow(/timestamp out of supported range/);
  });
  it("decide throws when now is outside the bounds", () =>
    expect(() => decide(base, "hold", snapshot, "b1", { e: "A" }, staff, 1e15)).toThrow(/timestamp out of supported range/));
  it("a snapshot timestamp outside the bounds throws", () => {
    const snap: Snapshot = { ...snapshot, objects: { ...snapshot.objects, Loan: [{ ...snapshot.objects.Loan![0]!, due_at: -7e13 }] } };
    const e = { action: "probe", snapshot: snap, scope: "b1", bindings: { loan: "l1", tz: "UTC" }, actor: staff, now: NOW };
    expect(() => evalValue(base, dateIn(ref("loan.due_at"), ref("tz")), e)).toThrow(/does not fit its declared type/);
  });
  it("plus with a result outside the bounds throws (invalid input, not U)", () => {
    expect(() => val(plus(ref("t"), ref("d")), { t: MAX_TS, d: 1 })).toThrow(/timestamp out of supported range/);
    expect(() => val(plus(ref("t"), ref("d")), { t: MIN_TS, d: -1 })).toThrow(/timestamp out of supported range/);
    expect(val(plus(ref("t"), ref("d")), { t: MAX_TS - 1000, d: 1 })).toBe(MAX_TS);
  });
  it("dateIn pads a year below 1000 to 4 digits, so dates compare as strings", () => {
    const t = Date.UTC(999, 5, 15, 12);
    expect(val(dateIn(ref("t"), ref("tz")), { t, tz: "UTC" })).toBe("0999-06-15");
    expect(pred(lt(dateIn(ref("t"), ref("tz")), lit("1000-01-01")), { t, tz: "UTC" })).toBe("T");
  });
  it("a timestamp parameter outside the bounds is INVALID_BINDING/type", () => {
    expect(run("register", { ...ok, at: 9e15 })).toEqual(typeErr("at"));
    expect(run("register", { ...ok, at: MAX_TS + 1 })).toEqual(typeErr("at"));
    expect(run("register", { ...ok, at: MIN_TS - 1 })).toEqual(typeErr("at"));
  });
  it("a timestamp parameter at the bounds is accepted", () => {
    expect(run("register", { ...ok, at: MAX_TS })).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" });
    expect(run("register", { ...ok, at: MIN_TS })).toEqual({ layer: "domain", result: "NOTED", class: "recorded", row: "otherwise" });
  });
  it("a timestamp literal outside the bounds is an ExprError", () => {
    rejects(lt(ref("now"), lit(MAX_TS + 1)));
    rejects(lt(ref("now"), lit(MIN_TS - 1)));
    rejects(lt(ref("now"), lit(9e15)));
    accepts(lt(ref("now"), lit(MAX_TS)));
    accepts(lt(ref("now"), lit(MIN_TS)));
  });
  it("a timezone literal is checked like a timezone parameter", () => {
    rejects(eq(dateIn(ref("t"), lit("Not/AZone")), lit("2026-03-08")));
    accepts(eq(dateIn(ref("t"), lit("America/Los_Angeles")), lit("2026-03-08")));
    expect(run("register", { ...ok, tz: "Not/AZone" })).toEqual(typeErr("tz"));
  });
  it("an id or ref literal must be a non-empty string, like an id or ref parameter", () => {
    rejects(eq(ref("m"), lit("")));
    accepts(eq(ref("m"), lit("m1")));
    expect(run("register", { ...ok, member: "" })).toEqual(typeErr("member"));
  });
  it("a date literal follows the date parameter format", () => {
    rejects(eq(dateIn(ref("t"), ref("tz")), lit("2026-3-8")));
    expect(run("register", { ...ok, day: "2026-3-8" })).toEqual(typeErr("day"));
  });
});

describe("determinism and the fixed invocation set", () => {
  // Wall-clock reads: Date.now, Math.random, new Date / new Date() without an argument, a bare Date() call, performance.*.
  // new Date(t) with an argument and Intl.DateTimeFormat are not clock reads.
  const CLOCK = [/Date\.now/, /Math\.random/, /\bnew\s+Date\b(?!\s*\((?!\s*\)))/, /(?<!new\s+)(?<![\w.$])Date\s*\(/, /\bperformance\./];
  const hits = (text: string) => CLOCK.filter((re) => re.test(text));
  it("the clock patterns match clock reads and nothing else", () => {
    for (const bad of ["Date.now()", "Math.random()", "new Date;", "(new Date)", "new Date()", "new Date( )", "const d = Date();", "performance.now()"])
      expect(hits(bad).length, bad).toBeGreaterThan(0);
    for (const ok of ["new Date(t)", "Intl.DateTimeFormat(\"en-US\")", "// performance matters", "new Date(t).getTime()"]) expect(hits(ok), ok).toEqual([]);
  });
  it("the evaluator source reads no clock and no randomness", () => {
    const src = import.meta.glob(["../src/expr.ts", "../src/evaluate.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(src).sort()).toEqual(["../src/evaluate.ts", "../src/expr.ts"]);
    for (const [file, text] of Object.entries(src)) expect(hits(text).map(String), file).toEqual([]);
  });
  it("the same input twice gives equal results", () => {
    for (const [action, bindings] of [["checkout", { member: "m1", book: "bk1", sponsor: "m2" }], ["renew", { loan: "l1" }], ["hold", { e: null }]] as const)
      expect(run(action, bindings)).toEqual(run(action, bindings));
  });
  it("INVOCATION_RESULTS holds the fixed set, envelope results included", () =>
    expect([...INVOCATION_RESULTS]).toEqual(["REPLAYED", "IDEMPOTENCY_CONFLICT", "INVALID_BINDING", "SCOPE_DENIED", "PERMISSION_DENIED"]));
  // Must stay the last test: it reads every result collected above.
  it("no decide result is REPLAYED or IDEMPOTENCY_CONFLICT", () => {
    expect(seen.length).toBeGreaterThan(40);
    for (const r of seen) expect(["REPLAYED", "IDEMPOTENCY_CONFLICT"]).not.toContain("result" in r ? r.result : r.reason);
  });
});
