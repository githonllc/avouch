// Static UNKNOWN analysis (R12 unsafe_fallthrough and quantifier_absorbs_unknown): the abstract evaluator on synthetic
// paths, nullability from the field lists and the parameters, and the two checks on the toy library.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import fallthroughText from "../examples/library/mutations/lib-r12-unsafe-fallthrough.yaml?raw";
import absorbsText from "../examples/library/mutations/lib-r12-quantifier-absorbs-unknown.yaml?raw";
import absorbsNeqText from "../examples/library/mutations/lib-r12-quantifier-absorbs-unknown-neq.yaml?raw";
import { check } from "../src/checker";
import type { SourceFacts } from "../src/contract";
import { decide, evalPredicate, evalValue, type Env, type Row, type Snapshot } from "../src/evaluate";
import { checkPredicate, type Expr, type ExprContext, type Quantifier } from "../src/expr";
import { applyPatch, type Op } from "../src/patch";
import { MAX_NULLABLE_REFS, abstractEval, absorbingQuantifiers, freeNullableRefs, mayNullIn, mayUnknown, type MayNull } from "../src/unknown";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";

const ont = parse(ontologyText);
const facts: SourceFacts = buildLibraryFacts(doc, libraryEvidence(), config);
const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
// only the two kinds of the static UNKNOWN analysis
const unknownKinds = (r: ReturnType<typeof check>) => triples(r).filter(([, k]) => k === "unsafe_fallthrough" || k === "quantifier_absorbs_unknown");
const run = (ops: Op[], f: SourceFacts = facts) => check(applyPatch(ont, ops), f);

// expression builders
const E = (x: unknown) => x as Expr;
const r = (path: string) => E({ ref: path });
const L = (v: string | number | (string | number)[]) => E({ lit: v });
const op = (k: string, ...a: Expr[]) => E({ [k]: a });
const nav = (from: string, link: string, dir: "forward" | "reverse") => ({ nav: { from: { ref: from }, link, dir } });
const q = (k: "exists" | "none" | "all", as: string, inn: ReturnType<typeof nav>, where?: Expr) => E({ [k]: where === undefined ? { as, in: inn } : { as, in: inn, where } });
const whereOf = (e: Expr) => (Object.values(e)[0] as { where: Expr }).where;
// nullable paths are exactly the given ones
const S = (...paths: string[]): MayNull => (p: string) => paths.includes(p);

const BORROW: ExprContext = { action: "BORROW", locals: {} };
const RETURN: ExprContext = { action: "RETURN", locals: {} };
const GOOD = L("GOOD");
const loans = (from: string) => nav(from, "loan_member", "reverse");
const loanOverdue = { derived: { id: "loan_overdue", of: { ref: "loan_id" } } } as Expr;
const withDerived = (patch: Record<string, unknown>, extra: Op[] = []) =>
  applyPatch(ont, [...Object.entries(patch).map(([k, value]): Op => ({ op: "add", path: `/derivedProperties/loan_overdue/${k}`, value })), ...extra]);

describe("abstract evaluation", () => {
  it("an or with a null guard is not UNKNOWN; and of two nullable comparisons is", () => {
    const x = r("x"), y = r("y");
    expect(mayUnknown(ont, op("or", op("gt", x, L(1)), op("isNull", x)), S("x"))).toBe(false);
    expect(mayUnknown(ont, op("and", op("gt", x, L(1)), op("eq", y, L(2))), S("x", "y"))).toBe(true);
    // known false positive: the analysis ignores the correlation of eq(y, 2) and neq(y, 2)
    expect(mayUnknown(ont, op("and", op("gt", x, L(1)), op("eq", y, L(2)), op("neq", y, L(2))), S("x", "y"))).toBe(true);
  });

  it("in and subsetOf with a null operand are UNKNOWN", () => {
    const inSet = op("in", r("x"), L(["A", "B"]));
    const sub = op("subsetOf", r("x"), r("actor.keys"));
    for (const e of [inSet, sub]) {
      expect(mayUnknown(ont, e, S("x"))).toBe(true);
      expect(mayUnknown(ont, e, S())).toBe(false);
    }
  });

  it("plus and dateIn of a null operand are null", () => {
    expect(abstractEval(ont, op("isNull", op("plus", r("x"), r("d"))), (p: string) => p === "x")).toEqual(new Set(["T"]));
    expect(mayUnknown(ont, op("eq", op("dateIn", r("x"), r("tz")), r("z")), S("x"))).toBe(true);
  });

  it("a boolean value in predicate position: null is UNKNOWN", () => {
    expect(mayUnknown(ont, r("x"), S("x"))).toBe(true);
    expect(mayUnknown(ont, op("not", r("x")), S("x"))).toBe(true);
    expect(mayUnknown(ont, op("or", r("x"), op("isNull", r("x"))), S("x"))).toBe(false);
  });

  it(`more than ${MAX_NULLABLE_REFS} nullable references are UNKNOWN without enumeration`, () => {
    expect(MAX_NULLABLE_REFS).toBe(8);
    const guards = (n: number) => Array.from({ length: n }, (_, i) => `x${i + 1}`);
    const all = (ps: string[]) => op("and", ...ps.map((p) => op("isNotNull", r(p))));
    expect(mayUnknown(ont, all(guards(8)), S(...guards(8)))).toBe(false);
    expect(mayUnknown(ont, all(guards(9)), S(...guards(9)))).toBe(true);
  });

  it("a path read more than once counts once", () => {
    const x = r("x");
    expect(freeNullableRefs(ont, op("and", op("isNotNull", x), op("eq", x, L(1)), op("neq", x, L(2))), S("x"))).toEqual(["x"]);
  });

  it("the outer count sees only reads outside quantifiers; the body is analysed on its own", () => {
    const e = q("exists", "l", loans("member_id"), op("eq", r("l.a"), r("x")));
    const mn = S("x", "l.a");
    expect(freeNullableRefs(ont, e, mn)).toEqual([]);
    expect(mayUnknown(ont, e, mn)).toBe(false);
    expect(mayUnknown(ont, whereOf(e), mn)).toBe(true);
  });

  it("known false positive: the body does not see an outer guard", () => {
    const body = op("eq", r("l.a"), r("x"));
    const e = op("and", op("isNotNull", r("x")), q("all", "l", loans("member_id"), body));
    expect(mayUnknown(ont, whereOf((e as { and: Expr[] }).and[1]), S("x"))).toBe(true);
  });
});

describe("nullability", () => {
  it("empty navigation from a null optional ref is not UNKNOWN", () => {
    const o = applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/parameters/member_id/optional", value: true }]);
    const e = q("all", "l", loans("member_id"), op("eq", r("l.state"), L("ACTIVE")));
    expect(absorbingQuantifiers(o, facts, e, BORROW)).toEqual([]);
    expect(mayUnknown(o, e, mayNullIn(o, facts, BORROW))).toBe(false);
  });

  it("a property of an optional ref may be null; a nullable field may be null; now and actor are never null", () => {
    const o = applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/parameters/book_id/optional", value: true }]);
    expect(mayNullIn(o, facts, BORROW)("book_id.state")).toBe(true);
    expect(mayNullIn(ont, facts, BORROW)("book_id.state")).toBe(false);
    for (const x of [o, ont]) {
      const mn = mayNullIn(x, facts, BORROW);
      expect(mn("member_id.person_id")).toBe(true);
      expect(mn("now")).toBe(false);
      expect(mn("actor.id")).toBe(false);
    }
  });

  it("unknown nullability (no field list, or a field not listed) is analysed as may-be-null", () => {
    const want = [["R12", "quantifier_absorbs_unknown", "RETURN:returned_late:$.exists"]];
    const noList: SourceFacts = { ...facts, fieldList: (a, ot) => (ot === "Loan" ? null : facts.fieldList(a, ot)) };
    expect(unknownKinds(check(ont, noList))).toEqual(want);
    const fl = facts.fieldList("L3", "Loan")!;
    const m = new Map(fl.value);
    m.delete("due_date");
    const notListed: SourceFacts = { ...facts, fieldList: (a, ot) => (ot === "Loan" ? { ...fl, value: m } : facts.fieldList(a, ot)) };
    expect(unknownKinds(check(ont, notListed))).toEqual(want);
  });
});

describe("absorbingQuantifiers paths", () => {
  it("names each quantifier whose body may be UNKNOWN, with the type-error path notation", () => {
    const none = q("none", "l", loans("member_id"), op("neq", r("l.return_condition"), GOOD));
    expect(absorbingQuantifiers(ont, facts, op("and", op("isNotNull", r("member_id.person_id")), none), BORROW)).toEqual(["$.and[1].none"]);
    const inner = q("exists", "b", nav("l", "loan_branch", "forward"), op("eq", r("l.return_condition"), GOOD));
    const outer = q("all", "l", loans("member_id"), op("and", inner, op("isNotNull", r("l.state"))));
    expect(absorbingQuantifiers(ont, facts, outer, BORROW)).toEqual(["$.all.where.and[0].exists"]);
  });
});

describe("derived properties", () => {
  it("a boolean derived property is inlined with self replaced by its of", () => {
    const o = withDerived({ type: "boolean", expr: op("neq", r("self.return_condition"), GOOD) });
    const mn = mayNullIn(o, facts, RETURN);
    expect(mayUnknown(o, loanOverdue, mn)).toBe(true);
    expect(freeNullableRefs(o, loanOverdue, mn)).toEqual(["loan_id.return_condition"]);
    const o2 = withDerived({ type: "boolean", expr: op("eq", r("self.state"), L("ACTIVE")) });
    expect(mayUnknown(o2, loanOverdue, mayNullIn(o2, facts, RETURN))).toBe(false);
  });

  it("a scalar derived property is inlined too", () => {
    const withCond = (expr: Expr) => applyPatch(ont, [{ op: "add", path: "/derivedProperties/cond_of", value: { of: "Loan", type: "enum", expr } }]);
    const e = op("eq", E({ derived: { id: "cond_of", of: { ref: "loan_id" } } }), GOOD);
    const o = withCond(r("self.return_condition"));
    expect(mayUnknown(o, e, mayNullIn(o, facts, RETURN))).toBe(true);
    const o2 = withCond(r("self.state"));
    expect(mayUnknown(o2, e, mayNullIn(o2, facts, RETURN))).toBe(false);
  });

  it("a derived property of a null optional ref is null, so a quantifier-rooted one is UNKNOWN there", () => {
    const expr = q("exists", "b", nav("self", "loan_branch", "forward"));
    const optional: Op = { op: "add", path: "/actionTypes/RETURN/parameters/loan_id/optional", value: true };
    const o = withDerived({ type: "boolean", expr }, [optional]);
    const mn = mayNullIn(o, facts, RETURN);
    expect(mayUnknown(o, loanOverdue, mn)).toBe(true);
    expect(freeNullableRefs(o, loanOverdue, mn)).toEqual(["loan_id"]);
    const actor = { id: "P-1", keys: ["loan:create", "loan:close"], kind: "person" };
    // the concrete result: this is why the analysis must report it
    expect(evalPredicate(o, loanOverdue, { action: "RETURN", snapshot: { objects: {} }, scope: "BR-1", bindings: { loan_id: null }, actor, now: Date.UTC(2026, 0, 20, 12) })).toBe("U");
    const o2 = withDerived({ type: "boolean", expr });
    expect(mayUnknown(o2, loanOverdue, mayNullIn(o2, facts, RETURN))).toBe(false);
  });
});

describe("R12 on the toy", () => {
  const conditionCites = [{ cite: { doc: "L3", quote: "RETURN records the return_condition of the Loan: GOOD or DAMAGED." } }];
  const lateRow = {
    when: { passes: "c2" },
    result: "RETURNED_LATE",
    cites: [{ cite: { doc: "L6", quote: "RETURN after the due_date, on the date of the Branch timezone, is RETURNED_LATE." } }],
  };
  const withC2 = (expr: Expr) =>
    run([
      { op: "add", path: "/derivedProperties/loan_overdue/type", value: "boolean" },
      { op: "add", path: "/derivedProperties/loan_overdue/cite", value: { doc: "L3", quote: "A Loan is overdue when it is ACTIVE and its due_date has passed." } },
      { op: "add", path: "/actionTypes/RETURN/conditions/-", value: { id: "c2", expr, cites: conditionCites } },
      { op: "add", path: "/actionTypes/RETURN/decision/rows/1", value: lateRow },
    ]);
  const neqGood = op("neq", r("loan_id.return_condition"), GOOD);

  it("a condition that reads a derived property without expr is not analysed (the absent-expression rule)", () => {
    const r1 = withC2(op("and", loanOverdue, neqGood));
    expect(unknownKinds(r1)).toEqual([]);
    expect(triples(r1)).toContainEqual(["R12", "condition_unspecified", "RETURN:c2"]);
    expect(unknownKinds(withC2(neqGood))).toEqual([["R12", "unsafe_fallthrough", "RETURN:rows.1"]]);
  });

  it("a quantifier inside a derived property is reported once, under the derived property's key", () => {
    const hasBadLoan = {
      of: "Member", doc: "L3", doc_term: "RETURN records the return_condition", type: "boolean", cite: conditionCites[0].cite,
      expr: q("exists", "l", loans("self"), op("neq", r("l.return_condition"), GOOD)),
    };
    const res = run([
      { op: "add", path: "/derivedProperties/has_bad_loan", value: hasBadLoan },
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "c_bad", expr: { derived: { id: "has_bad_loan", of: { ref: "member_id" } } }, cites: conditionCites } },
    ]);
    expect(unknownKinds(res)).toEqual([["R12", "quantifier_absorbs_unknown", "derivedProperties.has_bad_loan:$.exists"]]);
  });

  it("each R12 mutation reports exactly its violation", () => {
    const patched = (text: string) => check(applyPatch(ont, parse(text).patch), facts);
    expect(triples(patched(fallthroughText))).toEqual([["R12", "unsafe_fallthrough", "BORROW:rows.0"]]);
    for (const text of [absorbsText, absorbsNeqText])
      expect(triples(patched(text))).toEqual([["R12", "quantifier_absorbs_unknown", "BORROW:returns_in_good_condition:$.none"]]);
  });
});

describe("the mutations change the decision", () => {
  const now = Date.UTC(2026, 0, 20, 12);
  const actor = { id: "P-1", keys: ["loan:create", "loan:close"], kind: "person" };
  const loan = (id: string, extra: Record<string, Row[string]>): Row => ({ id, branch_id: "BR-1", book_id: "B-1", member_id: "M-1", ...extra });
  const snapshot = (personId: string | null, loans: Row[]): Snapshot => ({
    objects: {
      Branch: [{ id: "BR-1", timezone: "UTC" }, { id: "BR-2", timezone: "UTC" }],
      Person: [{ id: "P-1" }, { id: "P-2" }],
      Book: [{ id: "B-1", branch_id: "BR-1", state: "AVAILABLE" }],
      Member: [
        { id: "M-1", branch_id: "BR-1", person_id: personId, blocked_until: null },
        { id: "M-9", branch_id: "BR-2", person_id: "P-1", blocked_until: null },
      ],
      Loan: loans,
    },
  });
  const active = (due: string) => loan("LN-1", { state: "ACTIVE", due_date: due, return_condition: null });
  const borrow = { member_id: "M-1", book_id: "B-1" };
  const borrowWith = (o: any, s: Snapshot) => decide(o, "BORROW", s, "BR-1", borrow, actor, now);

  it("unsafe_fallthrough: a null person_id is REJECTED on the clean toy and BORROWED after the mutation", () => {
    const s = snapshot(null, []);
    expect(borrowWith(ont, s)).toMatchObject({ layer: "domain", result: "REJECTED" });
    expect(borrowWith(applyPatch(ont, parse(fallthroughText).patch), s)).toMatchObject({ layer: "domain", result: "BORROWED" });
  });

  it("quantifier_absorbs_unknown: a Loan with a null return_condition is REFERRED on the clean toy and BORROWED after the mutation", () => {
    const s = snapshot("P-1", [active("2026-01-31")]);
    expect(borrowWith(ont, s)).toMatchObject({ layer: "domain", result: "REFERRED" });
    expect(borrowWith(applyPatch(ont, parse(absorbsText).patch), s)).toMatchObject({ layer: "domain", result: "BORROWED" });
  });
});

describe("unsafe_fallthrough: the three conditions", () => {
  const cites = [{ cite: { doc: "L6", quote: "Otherwise BORROW is BORROWED." } }];
  // BORROW with its decision table replaced; c may be UNKNOWN (person_id is nullable), d is another condition
  const table = (rows: [object, string][], otherwise: string) =>
    unknownKinds(
      run([
        {
          op: "replace",
          path: "/actionTypes/BORROW/decision",
          value: { hitPolicy: "first", order: ont.actionTypes.BORROW.decision.order, rows: rows.map(([when, result]) => ({ when, result, cites })), otherwise: { result: otherwise, cites } },
        },
      ]),
    );
  const c = "borrower_is_caller", d = "book_available";
  const report = (i: number) => [["R12", "unsafe_fallthrough", `BORROW:rows.${i}`]];

  it("control: passes(c) with an applied otherwise is reported", () => expect(table([[{ passes: c }, "REJECTED"]], "BORROWED")).toEqual(report(0)));
  it("(b) an earlier fails(c) row consumes the UNKNOWN: no report", () =>
    expect(table([[{ fails: c }, "REJECTED"], [{ passes: c }, "BORROWED"]], "BORROWED")).toEqual([]));
  it("(c) no later row and no otherwise is applied or pending: no report", () => expect(table([[{ passes: c }, "REJECTED"]], "REJECTED")).toEqual([]));
  it("(c) a later fails(c) row matches when c is UNKNOWN, so the rows after it are not reached: no report", () =>
    expect(table([[{ passes: c }, "REJECTED"], [{ fails: c }, "REJECTED"]], "BORROWED")).toEqual([]));
  it("(c) the later fails(c) row itself is reached: an applied result there is reported", () =>
    expect(table([[{ passes: c }, "REJECTED"], [{ fails: c }, "BORROWED"]], "REJECTED")).toEqual(report(0)));
  it("(c) an applied row before the later fails(c) row is reached: reported", () =>
    expect(table([[{ passes: c }, "REJECTED"], [{ passes: d }, "BORROWED"], [{ fails: c }, "REJECTED"]], "BORROWED")).toEqual(report(0)));
});

describe("derived properties: null of in a value position, and the absent-expression rule per body", () => {
  it("a scalar derived property of a null optional ref is null in a value position", () => {
    const o = applyPatch(ont, [
      { op: "add", path: "/derivedProperties/later", value: { of: "Loan", type: "timestamp", expr: op("plus", r("now"), L(86400)) } },
      { op: "add", path: "/actionTypes/RETURN/parameters/loan_id/optional", value: true },
    ]);
    const e = op("gt", E({ derived: { id: "later", of: { ref: "loan_id" } } }), r("now"));
    expect(mayUnknown(o, e, mayNullIn(o, facts, RETURN))).toBe(true);
    const actor = { id: "P-1", keys: ["loan:close"], kind: "person" };
    expect(evalPredicate(o, e, { action: "RETURN", snapshot: { objects: {} }, scope: "BR-1", bindings: { loan_id: null }, actor, now: Date.UTC(2026, 0, 20, 12) })).toBe("U");
  });

  it("each quantifier body of a derived property is analysed on its own; only a body that reaches a derived property without expression is skipped", () => {
    const cite = { doc: "L3", quote: "RETURN records the return_condition of the Loan: GOOD or DAMAGED." };
    const dp = (expr: Expr) => ({ of: "Loan", doc: "L3", doc_term: "RETURN records the return_condition", type: "boolean", cite, expr });
    const overdue = E({ derived: { id: "loan_overdue", of: { ref: "self" } } }); // declared without expression
    const body = op("neq", r("self.return_condition"), GOOD);
    const branch = nav("self", "loan_branch", "forward");
    const res = run([
      { op: "add", path: "/derivedProperties/loan_overdue/type", value: "boolean" },
      { op: "add", path: "/derivedProperties/loan_overdue/cite", value: { doc: "L3", quote: "A Loan is overdue when it is ACTIVE and its due_date has passed." } },
      { op: "add", path: "/derivedProperties/dq", value: dp(op("and", overdue, q("exists", "b", branch, body))) }, // a sibling reaches it
      { op: "add", path: "/derivedProperties/dq2", value: dp(q("exists", "b", branch, op("and", overdue, body))) }, // the body reaches it
    ]);
    expect(unknownKinds(res)).toEqual([["R12", "quantifier_absorbs_unknown", "derivedProperties.dq:$.and[1].exists"]]);
  });
});

describe("soundness property: concrete result in the abstract result (seeded)", () => {
  // mulberry32: a small deterministic generator
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const DAY = 86400;
  const now = Date.UTC(2026, 0, 20, 12);
  const actor = { id: "P-1", keys: ["loan:create", "loan:close"], kind: "person" };
  // RETURN with an optional loan_id, optional scalar parameters, and three derived properties of Loan: ov (boolean,
  // predicate root with a quantifier), cond_of (enum, value root) and later (timestamp, plus)
  const o = applyPatch(ont, [
    { op: "add", path: "/actionTypes/RETURN/parameters/loan_id/optional", value: true },
    { op: "add", path: "/actionTypes/RETURN/parameters/t", value: { type: "timestamp", optional: true } },
    { op: "add", path: "/actionTypes/RETURN/parameters/dur", value: { type: "duration", optional: true } },
    { op: "add", path: "/actionTypes/RETURN/parameters/keys", value: { type: { set: "string" }, optional: true } },
    { op: "add", path: "/actionTypes/RETURN/parameters/tz", value: { type: "timezone" } },
    { op: "add", path: "/derivedProperties/ov", value: { of: "Loan", type: "boolean", expr: op("or", op("neq", r("self.return_condition"), GOOD), q("exists", "b", nav("self", "loan_branch", "forward"))) } },
    { op: "add", path: "/derivedProperties/cond_of", value: { of: "Loan", type: "enum", expr: r("self.return_condition") } },
    { op: "add", path: "/derivedProperties/later", value: { of: "Loan", type: "timestamp", expr: op("plus", r("now"), L(DAY)) } },
  ]);
  // for evaluating a quantifier body alone: its variable becomes a parameter (evaluation only; not type-checked)
  const oBody = applyPatch(o, [
    { op: "add", path: "/actionTypes/RETURN/parameters/b", value: { type: { ref: "Branch" } } },
    { op: "add", path: "/actionTypes/RETURN/parameters/bk", value: { type: { ref: "Book" } } },
  ]);
  const QV: Record<string, { link: string; type: string; id: string }> = {
    b: { link: "loan_branch", type: "Branch", id: "BR-1" },
    bk: { link: "loan_book", type: "Book", id: "B-1" },
  };

  // typed expressions of bounded depth over the RETURN context; bound: the quantifier variables in scope
  const generator = (rand: () => number) => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const dv = (id: string) => E({ derived: { id, of: { ref: "loan_id" } } });
    const enumV = (bound: string[]): Expr => pick([r("loan_id.state"), r("loan_id.return_condition"), dv("cond_of"), ...(bound.includes("bk") ? [r("bk.state")] : [])]);
    const ts = (): Expr => pick([r("now"), r("t"), op("plus", r("t"), r("dur")), op("plus", r("now"), r("dur")), dv("later")]);
    const date = (bound: string[]): Expr => (rand() < 0.4 ? r("loan_id.due_date") : op("dateIn", ts(), bound.includes("b") && rand() < 0.5 ? r("b.timezone") : r("tz")));
    const leaf = (bound: string[]): Expr =>
      pick([
        () => op(pick(["eq", "neq"]), enumV(bound), rand() < 0.5 ? L(pick(["GOOD", "ACTIVE"])) : enumV(bound)),
        () => op("in", enumV(bound), L(["GOOD", "ACTIVE"])),
        () => op("subsetOf", r("keys"), r("actor.keys")),
        () => op("in", L("loan:create"), r("keys")),
        () => op(pick(["lt", "lte", "gt", "gte"]), ts(), ts()),
        () => op(pick(["lt", "gte"]), date(bound), date(bound)),
        () => op(pick(["isNull", "isNotNull"]), pick([() => enumV(bound), ts, () => date(bound), () => dv("ov")])()),
        () => dv("ov"),
      ])();
    const pred = (depth: number, bound: string[]): Expr => {
      if (depth === 0 || rand() < 0.25) return leaf(bound);
      const free = Object.keys(QV).filter((v) => !bound.includes(v));
      const forms = [
        () => op(pick(["and", "or"]), ...Array.from({ length: 2 + Math.floor(rand() * 2) }, () => pred(depth - 1, bound))),
        () => op("not", pred(depth - 1, bound)),
        ...(free.length ? [() => {
          const v = pick(free);
          return q(pick(["exists", "none", "all"] as const), v, nav("loan_id", QV[v].link, "forward"), rand() < 0.1 ? undefined : pred(depth - 1, [...bound, v]));
        }] : []),
      ];
      return pick(forms)();
    };
    return (bound: string[] = []) => pred(3, bound);
  };

  // A concrete environment that makes the paths of `nulls` null and the other read paths non-null; paths the expression
  // does not read are random. The combination actually realized is read back from the evaluator.
  const environment = (rand: () => number, reads: string[], nulls: Set<string>, extra: Record<string, string> = {}): Env => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const val = <T>(p: string, xs: readonly T[]): T | null => (reads.includes(p) ? (nulls.has(p) ? null : pick(xs)) : pick([null, ...xs]));
    return {
      action: "RETURN",
      scope: "BR-1",
      actor,
      now,
      bindings: { loan_id: val("loan_id", ["LN-1"]), t: val("t", [now - 2 * DAY * 1000, now + 2 * DAY * 1000]), dur: val("dur", [3600, 3 * DAY]), keys: val("keys", [["loan:create"], ["loan:x"]]), tz: pick(["UTC", "Asia/Tokyo"]), ...extra },
      snapshot: {
        objects: {
          Branch: [{ id: "BR-1", timezone: pick(["UTC", "Asia/Tokyo"]) }],
          Person: [{ id: "P-1" }],
          Book: [{ id: "B-1", branch_id: "BR-1", state: pick(["AVAILABLE", "ON_LOAN"]) }],
          Member: [{ id: "M-1", branch_id: "BR-1", person_id: "P-1", blocked_until: null }],
          Loan: [{ id: "LN-1", branch_id: "BR-1", book_id: "B-1", member_id: "M-1", state: pick(["ACTIVE", "RETURNED"]), due_date: pick(["2026-01-10", "2026-01-20", "2026-01-31"]), return_condition: val("loan_id.return_condition", ["GOOD", "DAMAGED"]) }],
        },
      },
    };
  };

  // every null combination of the nullable reads (two random variants each): the concrete result is in the abstract one
  function verify(rand: () => number, evalOnt: typeof o, e: Expr, mn: MayNull, extra?: Record<string, string>): { checked: number; u: number } {
    const reads = freeNullableRefs(o, e, mn);
    let checked = 0, u = 0;
    for (let mask = 0; mask < 2 ** reads.length; mask++)
      for (let variant = 0; variant < 2; variant++) {
        const env = environment(rand, reads, new Set(reads.filter((_, i) => (mask >> i) & 1)), extra);
        const concrete = evalPredicate(evalOnt, e, env);
        const realized = new Set(reads.filter((p) => evalValue(evalOnt, r(p), env) === null));
        const abstract = abstractEval(o, e, (p) => realized.has(p));
        expect(abstract.has(concrete), `${JSON.stringify(e)} with null ${[...realized]}: ${concrete} not in ${[...abstract]}`).toBe(true);
        if (concrete === "U") (u++, expect(mayUnknown(o, e, mn), JSON.stringify(e)).toBe(true));
        checked++;
      }
    return { checked, u };
  }

  it("holds for 1000 generated expressions and the bodies of their top-level quantifiers", () => {
    const rand = rng(20261005);
    const gen = generator(rand);
    const mn = mayNullIn(o, facts, RETURN);
    let checked = 0, u = 0, bodyU = 0;
    for (let n = 0; n < 1000; n++) {
      const e = gen();
      checkPredicate(o, e, RETURN); // the analysis precondition: the expression type-checks
      const res = verify(rand, o, e, mn);
      checked += res.checked;
      u += res.u;
      const k = Object.keys(e)[0];
      const qn = (e as unknown as Record<string, Quantifier>)[k];
      if (!(k in { exists: 1, none: 1, all: 1 }) || qn.where === undefined) continue;
      // the body alone, its variable bound to an element: a concrete U must be reported
      const body = verify(rand, oBody, qn.where, mayNullIn(o, facts, { ...RETURN, locals: { [qn.as]: QV[qn.as].type } }), { [qn.as]: QV[qn.as].id });
      checked += body.checked;
      if (body.u > 0) (bodyU++, expect(absorbingQuantifiers(o, facts, e, RETURN), JSON.stringify(e)).toContain(`$.${k}`));
    }
    // coverage of this seed: about 16.5k combinations, 5.3k concrete U, 115 bodies with a concrete U
    expect(checked).toBeGreaterThan(10000);
    expect(u).toBeGreaterThan(1000);
    expect(bodyU).toBeGreaterThan(50);
  });
});
