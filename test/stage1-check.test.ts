// Stage 1 static checks (expressions, scope, dispositions, decision tables: R1, R2, R4, R6, R12) on the toy library,
// and decide / navigation on the clean toy. Each case patches the clean toy, which has no violations.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import { check } from "../src/checker";
import { applyPatch, type Op } from "../src/patch";
import { decide, evalPredicate, type Row, type Snapshot } from "../src/evaluate";
import type { Expr } from "../src/expr";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";

const ont = parse(ontologyText);
const run = (ops: Op[], source: string = doc) => check(applyPatch(ont, ops), buildLibraryFacts(source, libraryEvidence(), config));
const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
const r1 = (key: unknown) => expect.objectContaining({ rule: "R1", key });
const cites = (d: string, quote: string) => [{ cite: { doc: d, quote } }];
// a source document with one exact text replaced (the text must occur)
const docWith = (from: string, to: string) => {
  expect(doc).toContain(from);
  return doc.replace(from, to);
};

describe("stage 1 checks", () => {
  describe("R1: expressions", () => {
    it("a cycle of derived properties is R1", () => {
      const d = (other: string) => ({
        of: "Loan", doc: "L3", doc_term: "A Loan is overdue", type: "date",
        cite: { doc: "L3", quote: "due_date is set by BORROW." }, expr: { derived: { id: other, of: { ref: "self" } } },
      });
      const r = run([
        { op: "add", path: "/derivedProperties/d1", value: d("d2") },
        { op: "add", path: "/derivedProperties/d2", value: d("d1") },
      ]);
      expect(r.violations).toContainEqual(r1(expect.stringMatching(/^derivedProperties\.d[12]$/)));
    });

    it("a quantifier variable named self is R1", () => {
      const expr = { exists: { as: "self", in: { nav: { from: { ref: "member_id" }, link: "loan_member", dir: "reverse" } } } };
      expect(run([{ op: "replace", path: "/actionTypes/BORROW/conditions/3/expr", value: expr }]).violations).toContainEqual(
        r1("actionTypes.BORROW.conditions.returns_in_good_condition"),
      );
    });

    it("self in a condition expression is R1", () => {
      const expr = { eq: [{ ref: "self.state" }, { lit: "AVAILABLE" }] };
      expect(run([{ op: "replace", path: "/actionTypes/BORROW/conditions/1/expr", value: expr }]).violations).toContainEqual(r1("actionTypes.BORROW.conditions.book_available"));
    });

    it("a set literal whose elements have different JSON types is R1", () => {
      const expr = { in: [{ ref: "book_id.state" }, { lit: ["AVAILABLE", 3] }] };
      expect(run([{ op: "replace", path: "/actionTypes/BORROW/conditions/1/expr", value: expr }]).violations).toContainEqual(r1("actionTypes.BORROW.conditions.book_available"));
    });

    it("an integer operand of plus is R1", () => {
      const r = run([
        { op: "add", path: "/actionTypes/BORROW/parameters/open_loans", value: { type: "integer", cite: { doc: "L2", quote: "open_loans counts the ACTIVE loans of the member" } } },
        {
          op: "add", path: "/actionTypes/BORROW/conditions/-",
          value: { id: "integer_probe", expr: { lt: [{ plus: [{ ref: "now" }, { ref: "open_loans" }] }, { ref: "now" }] }, cites: cites("L6", "only that Member may submit BORROW") },
        },
      ]);
      expect(r.violations).toContainEqual(r1("actionTypes.BORROW.conditions.integer_probe"));
    });

    it("{derived} of a derived property without a type is R1", () => {
      const r = run([
        {
          op: "add", path: "/actionTypes/RETURN/conditions/-",
          value: { id: "derived_probe", expr: { derived: { id: "loan_overdue", of: { ref: "loan_id" } } }, cites: cites("L3", "A Loan is overdue when it is ACTIVE and its due_date has passed.") },
        },
      ]);
      expect(r.violations).toContainEqual(r1("actionTypes.RETURN.conditions.derived_probe"));
    });
  });

  it("R12: a row whose condition reaches a derived property without an expression through two derived layers is condition_unspecified, with no R4", () => {
    const overdue = "A Loan is overdue when it is ACTIVE and its due_date has passed.";
    const r = run([
      { op: "add", path: "/derivedProperties/loan_overdue/type", value: "boolean" },
      { op: "add", path: "/derivedProperties/loan_overdue/cite", value: { doc: "L3", quote: overdue } },
      {
        op: "add", path: "/derivedProperties/overdue_active",
        value: {
          of: "Loan", doc: "L3", doc_term: "A Loan is overdue", type: "boolean", cite: { doc: "L3", quote: overdue },
          expr: { and: [{ derived: { id: "loan_overdue", of: { ref: "self" } } }, { eq: [{ ref: "self.state" }, { lit: "ACTIVE" }] }] },
        },
      },
      {
        op: "add", path: "/actionTypes/RETURN/conditions/-",
        value: { id: "overdue_probe", expr: { derived: { id: "overdue_active", of: { ref: "loan_id" } } }, cites: cites("L6", "RETURN after the due_date, on the date of the Branch timezone, is RETURNED_LATE.") },
      },
      { op: "replace", path: "/actionTypes/RETURN/decision/rows/1/when", value: { passes: "overdue_probe" } },
    ]);
    expect(triples(r)).toEqual([["R12", "condition_unspecified", "RETURN:overdue_probe"]]);
  });

  describe("scope", () => {
    it("a global type whose field list has the scope field is scope_field_present", () =>
      expect(triples(run([], docWith("Person\n- id\n```", "Person\n- id\n- branch_id\n```")))).toContainEqual(["R2", "scope_field_present", "Person.branch_id"]));

    it("a tenant type whose field list lacks the scope field is scope_field_missing", () =>
      expect(triples(run([], docWith("Member\n- id\n- branch_id\n", "Member\n- id\n")))).toEqual([["R2", "scope_field_missing", "Member.branch_id"]]));

    it("the scope field written in non_link_fields of a tenant type is non_link_field_stray", () => {
      const nl = { branch_id: { reason: "the Branch of the Member", cite: { doc: "L12", quote: "belongs to one Branch by branch_id" } } };
      expect(triples(run([{ op: "add", path: "/objectTypes/Member/non_link_fields", value: nl }]))).toEqual([["R6", "non_link_field_stray", "Member.branch_id"]]);
    });

    it("a scope cite that does not name the scope field is scope_by_not_in_quote", () =>
      expect(triples(run([{ op: "replace", path: "/scope/cite/quote", value: "A Branch is one library." }]))).toEqual([["R2", "scope_by_not_in_quote", "scope"]]));
  });

  it("a type on a property without a cite is type_without_provenance", () =>
    expect(triples(run([{ op: "replace", path: "/objectTypes/Book/properties/title", value: { class: "unknown", type: "enum" } }]))).toEqual([
      ["R2", "type_without_provenance", "Book.title"],
    ]));

  it("a set literal element not in the condition quotes is literal_unsupported, keyed by that element", () => {
    const expr = { in: [{ ref: "book_id.state" }, { lit: ["AVAILABLE", "ON_LOAN"] }] };
    expect(triples(run([{ op: "replace", path: "/actionTypes/BORROW/conditions/1/expr", value: expr }]))).toEqual([["R4", "literal_unsupported", "BORROW:book_available:ON_LOAN"]]);
  });

  it("R4: reading the policy Branch.timezone passes; the same read of an unknown-class property does not", () => {
    const r4 = (r: ReturnType<typeof check>) => triples(r).filter(([rule]) => rule === "R4");
    expect(r4(run([]))).toEqual([]);
    expect(r4(run([{ op: "replace", path: "/objectTypes/Branch/properties/timezone/class", value: "unknown" }]))).toEqual([
      ["R4", "precondition_reads_non_canonical", "RETURN:Branch.timezone"],
    ]);
  });

  describe("R4: a hand-written read of a derived property with an expression", () => {
    const r4 = (r: ReturnType<typeof check>) => triples(r).filter(([rule]) => rule === "R4");
    const key = ["R4", "precondition_reads_non_canonical", "RETURN:Loan.return_condition"];
    const stateCite = ont.objectTypes.Loan.properties.return_condition.cite;
    const derivedActive = (expr: object = { eq: [{ ref: "self.return_condition" }, { lit: "GOOD" }] }): Op[] => [
      {
        op: "add", path: "/derivedProperties/active_loan",
        value: { of: "Loan", doc: "L3", doc_term: "A Loan is overdue", type: "boolean", cite: { doc: "L3", quote: "RETURN records the return_condition of the Loan: GOOD or DAMAGED." }, expr },
      },
      {
        op: "add", path: "/actionTypes/RETURN/conditions/-",
        value: { id: "active_probe", unspecified: "probe", reads: ["active_loan"], cites: cites("L6", "RETURN after the due_date, on the date of the Branch timezone, is RETURNED_LATE.") },
      },
    ];
    const loanState = (value: object): Op => ({ op: "replace", path: "/objectTypes/Loan/properties/return_condition", value });

    it("(a) classifies the properties the expression reads", () =>
      expect(r4(run([...derivedActive(), { op: "replace", path: "/objectTypes/Loan/properties/return_condition/class", value: "unknown" }]))).toContainEqual(key));

    it("(b) a canonical property the expression reads is not reported", () =>
      expect(r4(run(derivedActive()))).not.toContainEqual(key));

    it("(c) the canonical_values exception applies to the expanded value read", () => {
      const derivedState = (values: string[]) => loanState({ class: "derived", type: "enum", cite: stateCite, canonical_values: { values, cite: stateCite } });
      expect(r4(run([...derivedActive(), derivedState(["GOOD"])]))).not.toContainEqual(key);
      expect(r4(run([...derivedActive(), derivedState(["DAMAGED"])]))).toContainEqual(key);
    });

    it("(d) an ill-typed derived expression does not crash check; R1 still reports it", () => {
      const r = run(derivedActive({ eq: [{ ref: "self.return_condition" }, { lit: 1 }] }));
      expect(r.violations).toContainEqual(r1("derivedProperties.active_loan"));
    });

    it("(e) malformed linkTypes with a nav in the derived expression does not throw", () => {
      const nav = { exists: { as: "x", in: { nav: { from: { ref: "self" }, link: "loan_member", dir: "forward" } }, where: { lit: true } } };
      expect(() => run([...derivedActive(nav), { op: "replace", path: "/linkTypes", value: null }])).not.toThrow();
    });
  });

  describe("R12: row order", () => {
    it("two rows that quote the same sentence and give different results are row_order_mismatch", () => {
      const same = cites("L14", "BORROWED, RETURNED or RETURNED_LATE when the change is made, REJECTED when nothing is changed");
      const r = run([
        { op: "replace", path: "/actionTypes/RETURN/decision/rows/0/cites", value: same },
        { op: "replace", path: "/actionTypes/RETURN/decision/rows/1/cites", value: same },
      ]);
      expect(triples(r)).toEqual([["R12", "row_order_mismatch", "RETURN:rows.0:rows.1"]]);
    });

    it("A, B, A: a third row whose cite comes before the second row's is row_order_mismatch", () => {
      const row = { when: { fails: "loan_active" }, result: "REJECTED", cites: cites("L6", "BORROW by a blocked Member is REJECTED.") };
      expect(triples(run([{ op: "add", path: "/actionTypes/RETURN/decision/rows/-", value: row }]))).toEqual([["R12", "row_order_mismatch", "RETURN:rows.1:rows.2"]]);
    });

    it("two rows with the same result in reverse source order pass", () => {
      const r = run([
        { op: "remove", path: "/actionTypes/BORROW/decision/rows/1" },
        { op: "add", path: "/actionTypes/BORROW/decision/rows/0", value: ont.actionTypes.BORROW.decision.rows[1] },
      ]);
      expect(r.violations).toEqual([]);
    });
  });

  it("principals {kinds, cite}: a verbatim cite passes; a cite that is not verbatim is R2", () => {
    const withPrincipals = (quote: string) =>
      run([{ op: "add", path: "/actionTypes/BORROW/permission/principals", value: { kinds: ["person"], cite: { doc: "L6", quote } } }]);
    expect(withPrincipals("The caller of an action is a Person.").violations).toEqual([]);
    expect(triples(withPrincipals("The caller is a Person."))).toEqual([["R2", "generic", ".actionTypes.BORROW.permission.principals.cite"]]);
  });

  it("principals on {none}: R2 checks its cite; R10 is the same as without principals", () => {
    // The toy adapter gives RETURN the key `loan:close`, so every case keeps the R10 permission_mismatch: R10 does not read principals.
    const NONE = { none: "anyone may return a loan", cite: { doc: "L10", quote: "`loan:close`" } };
    const withNone = (principals?: unknown) =>
      run([{ op: "replace", path: "/actionTypes/RETURN/permission", value: principals === undefined ? NONE : { ...NONE, principals } }]);
    const mismatch = ["R10", "permission_mismatch", "RETURN"];
    expect(triples(withNone())).toEqual([mismatch]);
    expect(triples(withNone({ kinds: ["person"], cite: { doc: "L6", quote: "The caller of an action is a Person." } }))).toEqual([mismatch]);
    expect(triples(withNone({ kinds: ["person"], cite: { doc: "L6", quote: "The caller is a Person." } }))).toEqual([
      ["R2", "generic", ".actionTypes.RETURN.permission.principals.cite"],
      mismatch,
    ]);
  });
});

describe("decide on the clean toy", () => {
  const now = Date.UTC(2026, 0, 20, 12);
  const actor = { id: "P-1", keys: ["loan:create", "loan:close"], kind: "person" };
  const loan = (id: string, extra: Record<string, Row[string]>): Row => ({ id, branch_id: "BR-1", book_id: "B-1", member_id: "M-1", ...extra });
  const snapshot = (loans: Row[]): Snapshot => ({
    objects: {
      Branch: [{ id: "BR-1", timezone: "UTC" }, { id: "BR-2", timezone: "UTC" }],
      Person: [{ id: "P-1" }, { id: "P-2" }],
      Book: [{ id: "B-1", branch_id: "BR-1", state: "AVAILABLE" }],
      Member: [
        { id: "M-1", branch_id: "BR-1", person_id: "P-1", blocked_until: null },
        { id: "M-9", branch_id: "BR-2", person_id: "P-1", blocked_until: null },
      ],
      Loan: loans,
    },
  });
  const returned = (condition: string) => loan("LN-0", { state: "RETURNED", due_date: "2026-01-10", return_condition: condition });
  const active = (due: string) => loan("LN-1", { state: "ACTIVE", due_date: due, return_condition: null });
  const borrow = { member_id: "M-1", book_id: "B-1" };

  const cases: [string, () => ReturnType<typeof decide>][] = [
    ["REJECTED", () => decide(ont, "BORROW", snapshot([returned("GOOD")]), "BR-1", borrow, { ...actor, id: "P-2" }, now)],
    ["REFERRED", () => decide(ont, "BORROW", snapshot([returned("DAMAGED")]), "BR-1", borrow, actor, now)],
    ["BORROWED", () => decide(ont, "BORROW", snapshot([returned("GOOD")]), "BR-1", borrow, actor, now)],
    ["RETURNED_LATE", () => decide(ont, "RETURN", snapshot([active("2026-01-15")]), "BR-1", { loan_id: "LN-1" }, actor, now)],
    ["RETURNED", () => decide(ont, "RETURN", snapshot([active("2026-01-31")]), "BR-1", { loan_id: "LN-1" }, actor, now)],
  ];
  for (const [want, got] of cases) it(`gives ${want}`, () => expect(got()).toMatchObject({ layer: "domain", result: want }));

  it("navigating member_person in reverse from a Person returns only the Members of the current scope", () => {
    const o = applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/parameters/person", value: { type: { ref: "Person" } } }]);
    const has = (member: string): Expr =>
      ({ exists: { as: "m", in: { nav: { from: { ref: "person" }, link: "member_person", dir: "reverse" } }, where: { eq: [{ ref: "m" }, { lit: member }] } } }) as Expr;
    const at = (scope: string, member: string) =>
      evalPredicate(o, has(member), { action: "BORROW", snapshot: snapshot([]), scope, bindings: { person: "P-1" }, actor, now });
    expect([at("BR-1", "M-1"), at("BR-1", "M-9"), at("BR-2", "M-1"), at("BR-2", "M-9")]).toEqual(["T", "F", "F", "T"]);
  });
});

describe("stage 1 checks: row order by position cite, and each rule's logic", () => {
  const L6 = (quote: string) => cites("L6", quote);
  const LATE = "RETURN after the due_date, on the date of the Branch timezone, is RETURNED_LATE.";
  const OUTCOMES = "BORROWED, RETURNED or RETURNED_LATE when the change is made";
  const mutation = (name: string) =>
    parse(Object.entries(import.meta.glob("../examples/library/mutations/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>).find(([f]) => f.endsWith(`${name}.yaml`))![1]).patch as Op[];

  it("a row whose first result-naming cite is in another section is not compared, even if it also cites the shared section", () => {
    const referred = [{ cite: { doc: "L14", quote: "REFERRED when a librarian must decide" } }, ...L6("BORROW by a Member with a Loan that is not returned in GOOD condition is REFERRED to a librarian.")];
    const r = run([...mutation("lib-r12-row-order-swapped"), { op: "replace", path: "/actionTypes/BORROW/decision/rows/2/cites", value: referred }]);
    expect(r.violations).toEqual([]);
  });

  it("second cites in a shared section do not change the position cites (first listed section)", () => {
    const r = run([
      { op: "add", path: "/actionTypes/RETURN/decision/rows/0/cites/-", value: { cite: { doc: "L14", quote: "REJECTED when nothing is changed" } } },
      { op: "add", path: "/actionTypes/RETURN/decision/rows/1/cites/-", value: { cite: { doc: "L14", quote: OUTCOMES } } },
    ]);
    expect(r.violations).toEqual([]);
  });

  it("rows that are not adjacent are compared", () => {
    const rows = [
      { when: { passes: "returned_late" }, result: "RETURNED_LATE", cites: L6(LATE) },
      { when: { passes: "returned_late" }, result: "RETURNED_LATE", cites: cites("L14", OUTCOMES) },
      { when: { fails: "loan_active" }, result: "REJECTED", cites: L6("RETURN of a Loan that is not ACTIVE is REJECTED.") },
    ];
    expect(triples(run([{ op: "replace", path: "/actionTypes/RETURN/decision/rows", value: rows }]))).toEqual([["R12", "row_order_mismatch", "RETURN:rows.0:rows.2"]]);
  });

  it("a row's position in a section is its earliest cite there, whatever the cite order", () => {
    const blocked = [...L6("RETURN of a Loan that is not ACTIVE is REJECTED."), ...L6("BORROW by a blocked Member is REJECTED.")];
    expect(run([{ op: "replace", path: "/actionTypes/BORROW/decision/rows/2/cites", value: blocked }]).violations).toEqual([]);
  });

  it("positions in different sections are not compared", () =>
    expect(run([{ op: "replace", path: "/actionTypes/RETURN/decision/rows/1/cites", value: cites("L14", OUTCOMES) }]).violations).toEqual([]));

  for (const [name, triple] of [
    ["lib-r12-decision-table-missing", ["R12", "decision_table_missing", "RETURN"]],
    ["lib-r12-otherwise-missing", ["R12", "otherwise_missing", "RETURN"]],
    ["lib-r12-result-unsupported", ["R12", "result_unsupported", "RETURN:rows.0"]],
    ["lib-r12-row-order-swapped", ["R12", "row_order_mismatch", "BORROW:rows.2:rows.3"]],
    ["lib-r4-literal-unsupported", ["R4", "literal_unsupported", "BORROW:book_available:ON_LOAN"]],
    ["lib-r2-disposition-not-in-quote", ["R2", "disposition_not_in_quote", "dispositions.REFERRED"]],
  ] as const)
    it(`mutation ${name} reports exactly ${triple.join(" ")}`, () => expect(triples(run(mutation(name)))).toEqual([[...triple]]));

  it("rows with different results and no order cite are row_order_uncited", () =>
    expect(triples(run([{ op: "remove", path: "/actionTypes/BORROW/decision/order" }]))).toEqual([["R12", "row_order_uncited", "BORROW"]]));

  it("next: {unspecified} is next_unspecified", () =>
    expect(triples(run([{ op: "replace", path: "/actionTypes/BORROW/decision/rows/3/next", value: { unspecified: "who decides is not stated" } }]))).toEqual([
      ["R12", "next_unspecified", "BORROW:rows.3"],
    ]));

  it("a pending result needs next, and a result of another class has none", () => {
    expect(triples(run([{ op: "remove", path: "/actionTypes/BORROW/decision/rows/3/next" }]))).toEqual([["R1", "generic", "actionTypes.BORROW.decision"]]);
    expect(triples(run([{ op: "add", path: "/actionTypes/BORROW/decision/otherwise/next", value: { actions: ["RETURN"] } }]))).toEqual([["R1", "generic", "actionTypes.BORROW.decision"]]);
  });

  it("a disposition named like an invocation result is R1", () => {
    const d = { class: "rejected", cite: { doc: "L14", quote: "REJECTED when nothing is changed" } };
    expect(triples(run([{ op: "add", path: "/dispositions/PERMISSION_DENIED", value: d }]))).toContainEqual(["R1", "generic", "dispositions.PERMISSION_DENIED"]);
  });

  it("an object type listed twice in scope is R1", () =>
    expect(triples(run([{ op: "add", path: "/scope/global/-", value: ont.scope.global[0] }]))).toEqual([["R1", "generic", "scope"]]));

  it("a typed derived property without an expression or a cite is type_without_provenance", () =>
    expect(triples(run([{ op: "add", path: "/derivedProperties/loan_overdue/type", value: "boolean" }]))).toEqual([["R2", "type_without_provenance", "derivedProperties.loan_overdue"]]));

  const activeLoan = (extra: object) => ({
    of: "Loan", doc: "L3", doc_term: "A Loan is overdue", type: "boolean", expr: { eq: [{ ref: "self.state" }, { lit: "ACTIVE" }] }, ...extra,
  });
  it("a derived property with an expression and no cite is R1 only (no type_without_provenance)", () =>
    expect(triples(run([{ op: "add", path: "/derivedProperties/active_loan", value: activeLoan({}) }]))).toEqual([["R1", "generic", "derivedProperties.active_loan"]]));

  it("a derived literal not in the derived property's own quote is literal_unsupported", () =>
    expect(triples(run([{ op: "add", path: "/derivedProperties/active_loan", value: activeLoan({ cite: { doc: "L3", quote: "due_date is set by BORROW." } }) }]))).toEqual([
      ["R4", "literal_unsupported", "derivedProperties.active_loan:ACTIVE"],
    ]));

  describe("canonical_values in an expression", () => {
    // Book.state becomes derived; book_available compares it by eq with AVAILABLE
    const derivedState = (values: string[]) => ({
      op: "replace" as const, path: "/objectTypes/Book/properties/state",
      value: { class: "derived", type: "enum", cite: ont.objectTypes.Book.properties.state.cite, canonical_values: { values, cite: ont.objectTypes.Book.properties.state.cite } },
    });
    it("an eq with a literal the source marks canonical passes", () => expect(run([derivedState(["AVAILABLE"])]).violations).toEqual([]));
    it("an eq with another literal is precondition_reads_non_canonical", () =>
      expect(triples(run([derivedState(["ON_LOAN"])]))).toEqual([["R4", "precondition_reads_non_canonical", "BORROW:Book.state"]]));
  });

  it("an empty set literal is R1", () => {
    const expr = { in: [{ ref: "book_id.state" }, { lit: [] }] };
    expect(run([{ op: "replace", path: "/actionTypes/BORROW/conditions/1/expr", value: expr }]).violations).toContainEqual(r1("actionTypes.BORROW.conditions.book_available"));
  });

  it("duplicate condition ids: every entry takes the analysis of the last entry that has an expr", () => {
    const valid = ont.actionTypes.RETURN.conditions[0];
    const conds = (second: object) => run([{ op: "replace", path: "/actionTypes/RETURN/conditions", value: [valid, { id: "loan_active", ...second, cites: valid.cites }, ont.actionTypes.RETURN.conditions[1]] }]);
    // the unspecified entry has no analysis: the expr entry's analysis is used (no type error); a row using it is condition_unspecified
    expect(triples(conds({ unspecified: "x" })).sort()).toEqual([
      ["R1", "generic", "actionTypes.RETURN.conditions.loan_active"],
      ["R12", "condition_unspecified", "RETURN:loan_active"],
    ]);
    // a later ill-typed expr entry wins over the earlier valid one: its type error is reported for both entries
    const r = conds({ expr: { eq: [{ ref: "loan_id.state" }, { ref: "now" }] } });
    expect(r.violations.map((x) => [x.rule, x.key, /compares enum with timestamp/.test(x.msg)])).toEqual([
      ["R1", "actionTypes.RETURN.conditions.loan_active", false],
      ["R1", "actionTypes.RETURN.conditions.loan_active", true],
      ["R1", "actionTypes.RETURN.conditions.loan_active", true],
    ]);
  });

  it("a condition with a type error that reaches a derived property without expr is R1 only, not condition_unspecified", () => {
    const r = run([
      { op: "add", path: "/derivedProperties/loan_overdue/type", value: "boolean" },
      { op: "add", path: "/derivedProperties/loan_overdue/cite", value: { doc: "L3", quote: "A Loan is overdue when it is ACTIVE and its due_date has passed." } },
      {
        op: "add", path: "/actionTypes/RETURN/conditions/-",
        value: { id: "probe", expr: { and: [{ derived: { id: "loan_overdue", of: { ref: "loan_id" } } }, { eq: [{ ref: "loan_id.state" }, { ref: "now" }] }] }, cites: L6(LATE) },
      },
      { op: "replace", path: "/actionTypes/RETURN/decision/rows/1/when", value: { passes: "probe" } },
    ]);
    expect(triples(r)).toEqual([["R1", "generic", "actionTypes.RETURN.conditions.probe"]]);
  });

  it("principals with an empty kinds list is R1", () =>
    expect(triples(run([{ op: "add", path: "/actionTypes/BORROW/permission/principals", value: { kinds: [], cite: { doc: "L6", quote: "The caller of an action is a Person." } } }]))).toEqual([
      ["R1", "generic", "actionTypes.BORROW"],
    ]));

  it("principals with an empty kinds list on {none} is R1", () => {
    const value = { none: "anyone may return a loan", cite: { doc: "L10", quote: "`loan:close`" }, principals: { kinds: [], cite: { doc: "L6", quote: "The caller of an action is a Person." } } };
    expect(triples(run([{ op: "replace", path: "/actionTypes/RETURN/permission", value }]))).toEqual([
      ["R1", "generic", "actionTypes.RETURN"],
      ["R10", "permission_mismatch", "RETURN"],
    ]);
  });
});
