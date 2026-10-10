import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import { applyPatch, type Op } from "../src/patch";
import {
  queryAction,
  queryCites,
  queryDisposition,
  queryList,
  queryObject,
  queryReads,
  queryWrites,
  showExpr,
  type QueryList,
} from "../src/query";

const clean = () => parse(ontologyText);
const patched = (ops: Op[]) => applyPatch(clean(), ops);
const cite = (doc: string, quote: string) => ({ doc, quote });
const L2_BLOCKED = "A librarian sets blocked_until when a member may not borrow until that time.";

describe("deletes queries", () => {
  const deleting = () => patched([{ op: "add", path: "/actionTypes/DELETE_LOAN", value: { deletes: ["Loan"] } }]);
  it("queryAction returns deletes and defaults to an empty list", () => {
    expect(queryAction(deleting(), "DELETE_LOAN")).toMatchObject({ deletes: ["Loan"] });
    expect(queryAction(clean(), "BORROW")).toMatchObject({ deletes: [] });
  });
  it("queryObject includes a delete-only writer with deletes true", () => {
    expect(queryObject(deleting(), "Loan")!.writers).toContainEqual({ action: "DELETE_LOAN", edits: [], creates: false, deletes: true });
  });
  it("queryWrites returns deleters for properties and none for derived properties", () => {
    expect(queryWrites(deleting(), "Loan.state")).toMatchObject({ deleters: ["DELETE_LOAN"] });
    expect(queryWrites(deleting(), "Loan.loan_overdue")).toMatchObject({ deleters: [] });
  });
});

describe("showExpr", () => {
  const borrow = clean().actionTypes.BORROW.conditions;
  const ret = clean().actionTypes.RETURN.conditions;

  it("renders the toy conditions", () => {
    expect(showExpr(borrow[0].expr)).toBe("member_id.person_id = actor.id");
    expect(showExpr(borrow[1].expr)).toBe('book_id.state = "AVAILABLE"');
    expect(showExpr(borrow[2].expr)).toBe("member_id.blocked_until is null or member_id.blocked_until <= now");
    expect(showExpr(borrow[3].expr)).toBe(
      'all l in member_id.loan_member(reverse) where (l.return_condition is not null and l.return_condition = "GOOD")',
    );
    expect(showExpr(ret[1].expr)).toBe("exists b in loan_id.loan_branch(forward) where dateIn(now, b.timezone) > loan_id.due_date");
  });

  it("renders a set literal element by element", () => {
    expect(showExpr({ in: [{ ref: "r.state" }, { lit: ["STARTED", "PAUSED"] }] })).toBe('r.state in ["STARTED", "PAUSED"]');
    expect(showExpr({ in: [{ lit: 3 }, { lit: [1, 2] }] })).toBe("3 in [1, 2]");
  });

  it("renders not, derived, plus, subsetOf and unknown nodes", () => {
    expect(showExpr({ not: [{ and: [{ ref: "a" }, { ref: "b" }] }] })).toBe("not(a and b)");
    expect(showExpr({ derived: { id: "loan_overdue", of: { ref: "loan_id" } } })).toBe("loan_overdue(loan_id)");
    expect(showExpr({ lt: [{ plus: [{ ref: "now" }, { ref: "grace" }] }, { ref: "x.due" }] })).toBe("now + grace < x.due");
    expect(showExpr({ subsetOf: [{ ref: "keys" }, { ref: "actor.keys" }] })).toBe("keys subsetOf actor.keys");
    expect(showExpr({ neq: [{ ref: "a" }, { lit: "B" }] })).toBe('a != "B"');
    expect(showExpr({ gte: [{ ref: "a" }, { ref: "b" }] })).toBe("a >= b");
    expect(showExpr({ and: [{ or: [{ ref: "a" }, { ref: "b" }] }, { ref: "c" }] })).toBe("(a or b) and c");
    expect(showExpr({ bogus: [1] })).toBe('<?>{"bogus":[1]}');
    expect(showExpr({ eq: 5 })).toBe('<?>{"eq":5}');
    expect(() => showExpr(undefined)).not.toThrow();
  });
});

describe("queryAction", () => {
  it("gives the BORROW decision with the conditions each row requires", () => {
    const a = queryAction(clean(), "BORROW")!;
    expect(a.decision!.order).toEqual(cite("L6", "BORROW and RETURN check their rules from top to bottom; the first rule that matches decides."));
    const rows = a.decision!.rows;
    expect(rows.map((r) => r.row)).toEqual([0, 1, 2, 3, "otherwise"]);
    expect(rows[3]).toMatchObject({ row: 3, when: { fails: "returns_in_good_condition" }, result: "REFERRED", class: "pending", blockedBy: null });
    expect(rows[3].next).toEqual({ external: "a librarian decides", cite: cite("L14", "REFERRED when a librarian must decide") });
    expect(rows[3].requires).toEqual([
      { condition: "borrower_is_caller", must: "pass", specified: true },
      { condition: "book_available", must: "pass", specified: true },
      { condition: "member_not_blocked", must: "pass", specified: true },
      { condition: "returns_in_good_condition", must: "fail", specified: true },
    ]);
    expect(rows[4]).toMatchObject({ row: "otherwise", when: null, result: "BORROWED", class: "applied", next: null });
    expect(rows[4].requires).toEqual([
      { condition: "borrower_is_caller", must: "pass", specified: true },
      { condition: "book_available", must: "pass", specified: true },
      { condition: "member_not_blocked", must: "pass", specified: true },
      { condition: "returns_in_good_condition", must: "pass", specified: true },
    ]);
    expect(rows[0].cites).toEqual([cite("L6", "BORROW by anyone other than that Member is REJECTED.")]);
  });

  it("gives the BORROW permission, transitions, effects and parameters", () => {
    const a = queryAction(clean(), "BORROW")!;
    expect(a.permission).toEqual({
      form: "keys",
      alternatives: [{ keys: ["loan:create"], conditionalKeys: [], cite: { doc: "L10", quote: "`loan:create`" }, conditionalCite: null, principals: null }],
    });
    expect(a.transitions).toEqual([{ object: "Book", from: "AVAILABLE", to: "ON_LOAN" }]);
    expect(a.idempotencyKey).toBeNull();
    expect(a).toMatchObject({ id: "BORROW", context: "Circulation", doc: "L6", docTerm: "BORROW creates a Loan", evidence: "borrow" });
    expect(a.creates).toEqual(["Loan"]);
    expect(a.emits).toEqual(["loan.created"]);
    expect(a.edits).toEqual([{ prop: "Book.state", cite: null }, { prop: "Member.open_loans", cite: null }]);
    expect(a.parameters[0]).toEqual({ name: "member_id", type: { ref: "Member" }, optional: false, values: null, cite: cite("L6", "BORROW takes member_id") });
    expect(a.linkEffects.find((l) => l.link === "member_person")).toEqual({
      link: "member_person", kind: "none", text: "BORROW does not change the Person of a Member", cite: null, scenarios: [],
    });
    expect(a.crossContext).toEqual({ via: "same_transaction", unspecified: null, cite: cite("L6", "BORROW and RETURN write Book and Member in the same transaction as the Loan.") });
    expect(a.conditions[1]).toMatchObject({ id: "book_available", exprText: 'book_id.state = "AVAILABLE"', unspecified: null, reads: [], scenarios: [] });
    expect(queryAction(clean(), "NOPE")).toBeNull();
  });

  it("gives the values of an enum parameter", () => {
    const ont = patched([
      {
        op: "add",
        path: "/actionTypes/RETURN/parameters/return_condition",
        value: { type: "enum", values: ["GOOD", "DAMAGED"], optional: true, cite: cite("L3", "RETURN records the return_condition of the Loan: GOOD or DAMAGED.") },
      },
    ]);
    expect(queryAction(ont, "RETURN")!.parameters.find((p) => p.name === "return_condition")!.values).toEqual(["GOOD", "DAMAGED"]);
  });

  it("reads any_of with principals and conditional keys", () => {
    const ont = patched([
      {
        op: "replace",
        path: "/actionTypes/BORROW/permission",
        value: {
          any_of: [
            { keys: ["loan:create"], cite: cite("L10", "`loan:create`"), principals: { kinds: ["MEMBER"], cite: cite("L6", "The caller of an action is a Person.") } },
            { keys: ["loan:admin"], conditional_keys: ["loan:override"], cite: cite("L10", "x"), conditional_cite: cite("L10", "y") },
          ],
        },
      },
    ]);
    const p = queryAction(ont, "BORROW")!.permission;
    expect(p.form).toBe("keys");
    if (p.form !== "keys") return;
    expect(p.alternatives).toHaveLength(2);
    expect(p.alternatives[0].principals).toEqual({ kinds: ["MEMBER"], cite: cite("L6", "The caller of an action is a Person.") });
    expect(p.alternatives[1]).toEqual({ keys: ["loan:admin"], conditionalKeys: ["loan:override"], cite: cite("L10", "x"), conditionalCite: cite("L10", "y"), principals: null });
    const list = queryList(ont, "actions") as Extract<QueryList, { kind: "actions" }>;
    expect(list.items.find((i) => i.id === "BORROW")!.permissionKeys).toEqual(["loan:admin", "loan:create", "loan:override"]);
  });

  it("reads idempotencyKey, condition scenarios, edit_cites and the none form", () => {
    const ont = patched([
      { op: "add", path: "/actionTypes/BORROW/idempotencyKey", value: { required: true, cite: cite("L6", "BORROW takes book_id") } },
      { op: "add", path: "/actionTypes/BORROW/conditions/0/scenarios", value: ["S-1", "S-2"] },
      { op: "add", path: "/actionTypes/RETURN/edit_cites", value: { "Loan.state": { cite: cite("L6", "RETURN closes an ACTIVE Loan") } } },
      { op: "replace", path: "/actionTypes/RETURN/permission", value: { none: "anyone", cite: cite("L10", "z") } },
    ]);
    const b = queryAction(ont, "BORROW")!;
    expect(b.idempotencyKey).toEqual({ required: true, cite: cite("L6", "BORROW takes book_id") });
    expect(b.conditions[0].scenarios).toEqual(["S-1", "S-2"]);
    const r = queryAction(ont, "RETURN")!;
    expect(r.edits[0]).toEqual({ prop: "Loan.state", cite: cite("L6", "RETURN closes an ACTIVE Loan") });
    expect(r.permission).toEqual({ form: "none", reason: "anyone", cite: cite("L10", "z"), principals: null });
    expect(queryWrites(ont, "Loan.state")!.writers).toEqual([{ action: "RETURN", cite: cite("L6", "RETURN closes an ACTIVE Loan"), path: [] }]);
  });

  it("reads principals on the {none} form", () => {
    const principals = { kinds: ["MEMBER"], cite: cite("L6", "The caller of an action is a Person.") };
    const ont = patched([{ op: "replace", path: "/actionTypes/RETURN/permission", value: { none: "anyone", cite: cite("L10", "z"), principals } }]);
    expect(queryAction(ont, "RETURN")!.permission).toEqual({ form: "none", reason: "anyone", cite: cite("L10", "z"), principals });
  });

  it("marks a condition that reaches a derived property without expr as not specified", () => {
    const ont = applyPatch(chain(), [{ op: "add", path: "/actionTypes/RETURN/decision/rows/0", value: { when: { passes: "probe" }, result: "REJECTED" } }]);
    const rows = queryAction(ont, "RETURN")!.decision!.rows;
    expect(rows[0].requires).toEqual([{ condition: "probe", must: "pass", specified: false }]);
    expect(rows[0].blockedBy).toBeNull();
    expect(rows[1].requires[0]).toEqual({ condition: "probe", must: "fail", specified: false });
    expect(rows[1].blockedBy).toBe("probe");
    expect(rows[rows.length - 1]).toMatchObject({ row: "otherwise", blockedBy: "probe" });
  });

  it("marks a condition that fails the type check as not specified", () => {
    const ont = patched([
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "bad_probe", expr: { eq: [{ ref: "member_id.blocked_until" }, { lit: "soon" }] }, cites: [{ cite: cite("L2", L2_BLOCKED) }] } },
      { op: "add", path: "/actionTypes/BORROW/decision/rows/0", value: { when: { fails: "bad_probe" }, result: "REJECTED" } },
    ]);
    const rows = queryAction(ont, "BORROW")!.decision!.rows;
    expect(rows[0].requires).toEqual([{ condition: "bad_probe", must: "fail", specified: false }]);
    expect(rows[1].blockedBy).toBe("bad_probe");
  });

  it("reads an unspecified condition and blocks the rows after it", () => {
    const ont = patched([
      {
        op: "add",
        path: "/actionTypes/BORROW/conditions/-",
        value: { id: "open_loans_below_limit", unspecified: "probe", reads: ["Member.open_loans"], cites: [{ cite: cite("L6", "a Member who is not blocked") }] },
      },
      { op: "add", path: "/actionTypes/BORROW/decision/rows/0", value: { when: { fails: "open_loans_below_limit" }, result: "REJECTED" } },
    ]);
    const a = queryAction(ont, "BORROW")!;
    expect(a.conditions[4]).toEqual({
      id: "open_loans_below_limit", expr: null, exprText: null, unspecified: "probe", reads: ["Member.open_loans"],
      cites: [cite("L6", "a Member who is not blocked")], scenarios: [],
    });
    const rows = a.decision!.rows;
    expect(rows[0].requires).toEqual([{ condition: "open_loans_below_limit", must: "fail", specified: false }]);
    expect(rows[0].blockedBy).toBeNull();
    expect(rows[1].requires[0]).toEqual({ condition: "open_loans_below_limit", must: "pass", specified: false });
    expect(rows[1].blockedBy).toBe("open_loans_below_limit");
    expect(rows[5].blockedBy).toBe("open_loans_below_limit");
    expect(queryReads(ont, "Member.open_loans")!.conditions).toEqual([
      { action: "BORROW", condition: "open_loans_below_limit", source: "reads", direct: true, via: [], rows: [0] },
    ]);
  });
});

describe("queryDisposition", () => {
  it("lists the rows that give a result", () => {
    const d = queryDisposition(clean(), "RETURNED_LATE")!;
    expect(d).toMatchObject({ disposition: "RETURNED_LATE", class: "applied", cite: cite("L14", "BORROWED, RETURNED or RETURNED_LATE when the change is made") });
    expect(d.rows.map((r) => ({ action: r.action, row: r.row, requires: r.requires }))).toEqual([
      {
        action: "RETURN",
        row: 1,
        requires: [
          { condition: "loan_active", must: "pass", specified: true },
          { condition: "returned_late", must: "pass", specified: true },
        ],
      },
    ]);
    expect(queryDisposition(clean(), "REJECTED")!.rows.map((r) => [r.action, r.row])).toEqual([
      ["BORROW", 0],
      ["BORROW", 1],
      ["BORROW", 2],
      ["RETURN", 0],
    ]);
    expect(queryDisposition(clean(), "BORROWED")!.rows.map((r) => r.row)).toEqual(["otherwise"]);
    expect(queryDisposition(clean(), "NOPE")).toBeNull();
  });
});

describe("queryWrites", () => {
  it("gives the writers and creators of a property", () => {
    expect(queryWrites(clean(), "Member.open_loans")).toEqual({
      target: "Member.open_loans", kind: "property", unanalyzed: [],
      writers: [{ action: "BORROW", cite: null, path: [] }, { action: "RETURN", cite: null, path: [] }],
      creators: [], deleters: [],
    });
    const rc = queryWrites(clean(), "Loan.return_condition")!;
    expect(rc.writers).toEqual([{ action: "RETURN", cite: null, path: [] }]);
    expect(rc.creators).toEqual(["BORROW"]);
    expect(queryWrites(clean(), "Book.title")!.writers).toEqual([]);
    expect(queryWrites(clean(), "Book.nope")).toBeNull();
    expect(queryWrites(clean(), "Nope.state")).toBeNull();
  });

  it("expands a derived property through its inputs", () => {
    const d = queryWrites(clean(), "Loan.loan_overdue")!;
    expect(d.kind).toBe("derived");
    expect(d.creators).toEqual([]);
    expect(d.writers).toEqual([{ action: "RETURN", cite: null, path: ["Loan.state"] }]);
  });

  it("follows a derived chain through a derived property that has only reads", () => {
    const ont = chain();
    const w = queryWrites(ont, "Loan.A")!;
    expect(w.writers).toEqual([{ action: "RETURN", cite: null, path: ["Loan.B", "Loan.state"] }]);
    const r = queryReads(ont, "Loan.state")!;
    expect(r.conditions).toContainEqual({ action: "RETURN", condition: "probe", source: "expr", direct: false, via: ["A"], rows: [] });
    expect(r.derived).toContainEqual({ id: "A", source: "expr", direct: false, via: ["B"] });
    expect(r.derived).toContainEqual({ id: "B", source: "reads", direct: true, via: [] });
  });

  it("reports a cycle of derived properties in unanalyzed", () => {
    const loanCite = cite("L3", "The state of a Loan is ACTIVE or RETURNED.");
    const ont = patched([
      { op: "add", path: "/derivedProperties/A", value: { of: "Loan", type: "boolean", expr: { not: [{ derived: { id: "B", of: { ref: "self" } } }] }, cite: loanCite } },
      { op: "add", path: "/derivedProperties/B", value: { of: "Loan", type: "boolean", expr: { not: [{ derived: { id: "A", of: { ref: "self" } } }] }, cite: loanCite } },
    ]);
    const w = queryWrites(ont, "Loan.A")!;
    expect(w.writers).toEqual([]);
    expect(w.unanalyzed.map((u) => u.at).sort()).toEqual(["derivedProperties.A", "derivedProperties.B"]);
    expect(w.unanalyzed[0].error).toMatch(/cycle/);
    const r = queryReads(ont, "Loan.state")!;
    expect(r.unanalyzed.map((u) => u.at)).toEqual(["derivedProperties.A", "derivedProperties.B"]);
    expect(queryObject(ont, "Loan")!.unanalyzed.map((u) => u.at)).toEqual(["derivedProperties.A", "derivedProperties.B"]);
  });
});

const chain = () =>
  patched([
    { op: "add", path: "/derivedProperties/B", value: { of: "Loan", type: "boolean", reads: ["Loan.state"], cite: cite("L3", "The state of a Loan is ACTIVE or RETURNED.") } },
    {
      op: "add",
      path: "/derivedProperties/A",
      value: { of: "Loan", type: "boolean", expr: { not: [{ derived: { id: "B", of: { ref: "self" } } }] }, cite: cite("L3", "The state of a Loan is ACTIVE or RETURNED.") },
    },
    {
      op: "add",
      path: "/actionTypes/RETURN/conditions/-",
      value: { id: "probe", expr: { derived: { id: "A", of: { ref: "loan_id" } } }, cites: [{ cite: cite("L6", "RETURN closes an ACTIVE Loan") }] },
    },
  ]);

describe("queryReads", () => {
  it("gives the conditions, derived properties and materialized properties that read a property", () => {
    expect(queryReads(clean(), "Loan.state")).toEqual({
      target: "Loan.state", kind: "property", materialized: ["Member.open_loans"], unanalyzed: [],
      conditions: [{ action: "RETURN", condition: "loan_active", source: "expr", direct: true, via: [], rows: [0] }],
      derived: [{ id: "loan_overdue", source: "reads", direct: true, via: [] }],
    });
    expect(queryReads(clean(), "Loan.nope")).toBeNull();
  });

  it("separates a direct read from a read through a derived expression", () => {
    const ont = patched([
      { op: "add", path: "/derivedProperties/member_blocked", value: { of: "Member", type: "boolean", expr: { isNotNull: [{ ref: "self.blocked_until" }] }, cite: cite("L2", L2_BLOCKED) } },
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "blocked_probe", expr: { derived: { id: "member_blocked", of: { ref: "member_id" } } }, cites: [{ cite: cite("L2", L2_BLOCKED) }] } },
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "bad_probe", expr: { eq: [{ ref: "member_id.blocked_until" }, { lit: "soon" }] }, cites: [{ cite: cite("L2", L2_BLOCKED) }] } },
    ]);
    const r = queryReads(ont, "Member.blocked_until")!;
    expect(r.conditions).toContainEqual({ action: "BORROW", condition: "member_not_blocked", source: "expr", direct: true, via: [], rows: [2] });
    expect(r.conditions).toContainEqual({ action: "BORROW", condition: "blocked_probe", source: "expr", direct: false, via: ["member_blocked"], rows: [] });
    expect(r.derived).toEqual([{ id: "member_blocked", source: "expr", direct: true, via: [] }]);
    expect(r.unanalyzed.map((u) => u.at)).toEqual(["BORROW:bad_probe"]);
    const d = queryReads(ont, "Member.member_blocked")!;
    expect(d.kind).toBe("derived");
    expect(d.conditions).toEqual([{ action: "BORROW", condition: "blocked_probe", source: "expr", direct: true, via: [], rows: [] }]);
    expect(queryObject(ont, "Member")!.derived[0]).toMatchObject({ id: "member_blocked", type: "boolean", exprText: "self.blocked_until is not null" });
  });
});

describe("queryCites", () => {
  it("lists every claim that cites an anchor, by exact match", () => {
    const l14 = queryCites(clean(), "L14");
    expect(l14.claims).toHaveLength(6);
    expect(l14.claims[0]).toEqual({ path: "/dispositions/BORROWED/cite", subject: "dispositions.BORROWED", quote: "BORROWED, RETURNED or RETURNED_LATE when the change is made" });
    expect(l14.claims.map((c) => c.path)).toContain("/actionTypes/BORROW/decision/rows/3/next/cite");
    expect(l14.claims.find((c) => c.path === "/actionTypes/BORROW/decision/rows/3/next/cite")!.subject).toBe("actionTypes.BORROW.decision.rows[3]");
    expect(queryCites(clean(), "L4").claims).toEqual([{ path: "/stateMachines/Book", subject: "stateMachines.Book", quote: null }]);
    expect(queryCites(clean(), "L12").claims).toHaveLength(6);
    expect(queryCites(clean(), "L99")).toEqual({ anchor: "L99", claims: [] });
    const l6 = queryCites(clean(), "L6").claims;
    expect(l6[0]).toEqual({ path: "/actionTypes/BORROW", subject: "actionTypes.BORROW", quote: "BORROW creates a Loan" });
    expect(l6.find((c) => c.path === "/actionTypes/BORROW/conditions/0/cites/0/cite")!.subject).toBe("actionTypes.BORROW.conditions.borrower_is_caller");
  });
});

describe("queryList", () => {
  it("lists anchors, gaps and the other kinds", () => {
    const anchors = queryList(clean(), "anchors") as Extract<QueryList, { kind: "anchors" }>;
    expect(anchors.items).toContainEqual({ doc: "L14", claims: 6 });
    expect(anchors.items.map((i) => i.doc)).toEqual([...anchors.items.map((i) => i.doc)].sort());
    expect(queryList(clean(), "gaps")).toEqual({ kind: "gaps", items: [] });
    const actions = queryList(clean(), "actions") as Extract<QueryList, { kind: "actions" }>;
    expect(actions.items[0]).toEqual({ id: "BORROW", context: "Circulation", doc: "L6", docTerm: "BORROW creates a Loan", permissionKeys: ["loan:create"] });
    const derived = queryList(clean(), "derived") as Extract<QueryList, { kind: "derived" }>;
    expect(derived.items).toEqual([{ id: "loan_overdue", of: "Loan", type: null, docTerm: "A Loan is overdue", hasExpr: false }]);
    const links = queryList(clean(), "links") as Extract<QueryList, { kind: "links" }>;
    expect(links.items[0]).toEqual({ id: "loan_book", from: "Loan", to: "Book", cardinality: "N:1", via: "book_id", table: "loans" });
    const disp = queryList(clean(), "dispositions") as Extract<QueryList, { kind: "dispositions" }>;
    expect(disp.items.map((i) => i.id)).toEqual(["BORROWED", "RETURNED", "RETURNED_LATE", "REJECTED", "REFERRED"]);
    expect(queryList(clean(), "bogus")).toBeNull();
  });

  it("lists out-of-scope objects and gaps", () => {
    const ont = patched([
      { op: "add", path: "/outOfScopeObjectTypes", value: { Shelf: "not modelled" } },
      { op: "add", path: "/knownSourceGaps/-", value: { id: "G1", rule: "R9", kind: "criterion_uncovered", keys: ["BORROW:book_available"], doc_line: "L6", conflict: "c", proposed: "p" } },
    ]);
    const objects = queryList(ont, "objects") as Extract<QueryList, { kind: "objects" }>;
    expect(objects.items).toContainEqual({ id: "Shelf", context: null, datasource: null, outOfScope: "not modelled" });
    expect(objects.items).toContainEqual({ id: "Book", context: "Catalog", datasource: "books", outOfScope: null });
    expect(queryList(ont, "gaps")).toEqual({
      kind: "gaps",
      items: [{ id: "G1", rule: "R9", kind: "criterion_uncovered", keys: ["BORROW:book_available"], conflict: "c", proposed: "p" }],
    });
  });
});

describe("queryObject", () => {
  it("gives scope, writers, readers and the state machine", () => {
    const loan = queryObject(clean(), "Loan")!;
    expect(loan.scope).toBe("tenant");
    expect(loan.writers).toEqual([
      { action: "BORROW", edits: [], creates: true, deletes: false },
      { action: "RETURN", edits: ["Loan.state", "Loan.return_condition"], creates: false, deletes: false },
    ]);
    expect(loan.readers).toContainEqual({ action: "BORROW", condition: "returns_in_good_condition", props: ["Loan.return_condition"] });
    expect(loan.readers).toContainEqual({ action: "RETURN", condition: "loan_active", props: ["Loan.state"] });
    expect(loan.links).toContainEqual({ id: "loan_book", end: "from", other: "Book", cardinality: "N:1", via: "book_id" });
    expect(loan.stateMachine).toEqual({ doc: "L5", initial: "ACTIVE", terminal: ["RETURNED"], transitions: [{ from: "ACTIVE", to: "RETURNED", by: ["RETURN"], outOfScope: null }] });
    expect(queryObject(clean(), "Person")!.scope).toBe("global");
    expect(queryObject(clean(), "Branch")!.scope).toBe("root");
    const member = queryObject(clean(), "Member")!;
    expect(member.properties.find((p) => p.name === "open_loans")!.materializedFrom).toEqual({
      reads: ["Loan.state"], cites: [cite("L2", "is updated in the same transaction as the loan")],
    });
    expect(member.links).toContainEqual({ id: "loan_member", end: "to", other: "Loan", cardinality: "N:1", via: "member_id" });
    expect(queryObject(clean(), "Nope")).toBeNull();
    const noScope = clean();
    delete noScope.scope;
    expect(queryObject(noScope, "Loan")!.scope).toBeNull();
  });

  it("gives an out-of-scope object with its reason and its creators", () => {
    const ont = patched([
      { op: "add", path: "/outOfScopeObjectTypes", value: { Shelf: "not modelled" } },
      { op: "add", path: "/actionTypes/BORROW/creates/-", value: "Shelf" },
    ]);
    expect(queryObject(ont, "Shelf")).toEqual({
      id: "Shelf", context: null, datasource: null, doc: null, outOfScope: "not modelled", scope: null,
      properties: [], derived: [], stateMachine: null, links: [],
      writers: [{ action: "BORROW", edits: [], creates: true, deletes: false }], readers: [], unanalyzed: [],
    });
    expect(queryObject(ont, "Loan")!.outOfScope).toBeNull();
    expect(queryObject(clean(), "Shelf")).toBeNull();
  });

  it("lists a condition that fails the type check in unanalyzed", () => {
    expect(queryObject(clean(), "Loan")!.unanalyzed).toEqual([]);
    const ont = patched([
      { op: "add", path: "/actionTypes/RETURN/conditions/-", value: { id: "bad", expr: { eq: [{ ref: "loan_id.due_date" }, { lit: "soon" }] }, cites: [{ cite: cite("L6", "RETURN closes an ACTIVE Loan") }] } },
    ]);
    const u = queryObject(ont, "Loan")!.unanalyzed;
    expect(u.map((x) => x.at)).toEqual(["RETURN:bad"]);
    expect(u[0].error).not.toBe("");
  });
});

describe("robustness", () => {
  it("never throws on a malformed ontology", () => {
    for (const ont of [{ actionTypes: 5, objectTypes: [] }, null, "x", [], { actionTypes: { X: { decision: { rows: 3 }, conditions: 7 } }, objectTypes: { O: 1 } }]) {
      for (const kind of ["actions", "objects", "links", "derived", "dispositions", "anchors", "gaps"]) expect(() => queryList(ont, kind)).not.toThrow();
      expect(() => queryAction(ont, "X")).not.toThrow();
      expect(() => queryObject(ont, "O")).not.toThrow();
      expect(() => queryDisposition(ont, "X")).not.toThrow();
      expect(() => queryWrites(ont, "O.p")).not.toThrow();
      expect(() => queryReads(ont, "O.p")).not.toThrow();
      expect(() => queryCites(ont, "L1")).not.toThrow();
    }
    expect(queryAction({ actionTypes: 5, objectTypes: [] }, "X")).toBeNull();
  });

  it("returns plain JSON", () => {
    const ont = clean();
    for (const r of [queryAction(ont, "BORROW"), queryObject(ont, "Loan"), queryReads(ont, "Loan.state"), queryWrites(ont, "Loan.state"), queryCites(ont, "L6")])
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
