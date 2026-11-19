// Row effects: `effects` on a decision row and on `otherwise` narrows the action lists for that row (an upper bound).
// R1 (subset of the action lists), R5 (create_rule per row), R11 (materialization per row), R12 (same result, different
// effects) and query. Each case patches the clean toy, which has no violations.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import { check } from "../src/checker";
import { applyPatch, type Op } from "../src/patch";
import { queryAction, queryDisposition } from "../src/query";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";

const ont = parse(ontologyText);
const run = (ops: Op[]) => check(applyPatch(ont, ops), buildLibraryFacts(doc, libraryEvidence(), config));
const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
const only = (rule: string, r: ReturnType<typeof check>) => triples(r).filter(([x]) => x === rule);
// an `effects` op on a row (`rows/<i>`) or `otherwise` of an action
const fx = (action: string, row: string, value: unknown): Op => ({ op: "add", path: `/actionTypes/${action}/decision/${row}/effects`, value });

describe("row effects", () => {
  describe("R1: row effects are a subset of the action lists", () => {
    const EK = "actionTypes.BORROW.decision.rows.0.effects";

    it("effects within the action lists, and empty effects, pass", () => {
      const all = { creates: ["Loan"], edits: ["Book.state", "Member.open_loans"], emits: ["loan.created"], links: ["loan_book", "loan_member", "loan_branch"] };
      expect(run([fx("BORROW", "otherwise", all), fx("BORROW", "rows/0", {})]).violations).toEqual([]);
    });

    it("an entry that the action does not list is effect_not_declared", () => {
      expect(triples(run([fx("BORROW", "rows/0", { emits: ["loan.returned"] })]))).toContainEqual(["R1", "effect_not_declared", `${EK}.emits.loan.returned`]);
      expect(triples(run([fx("RETURN", "otherwise", { edits: ["Book.title"] })]))).toContainEqual(
        ["R1", "effect_not_declared", "actionTypes.RETURN.decision.otherwise.effects.edits.Book.title"],
      );
    });

    it("a link whose action entry is not the effect form is effect_not_declared", () => {
      expect(triples(run([fx("BORROW", "rows/0", { links: ["member_person"] })]))).toContainEqual(["R1", "effect_not_declared", `${EK}.links.member_person`]);
      expect(triples(run([fx("BORROW", "rows/0", { links: ["no_such_link"] })]))).toContainEqual(["R1", "effect_not_declared", `${EK}.links.no_such_link`]);
    });

    for (const [name, value] of [
      ["effects that is not a mapping", []],
      ["a kind that is not a list", { edits: "Book.state" }],
      ["an entry twice in one list", { edits: ["Book.state", "Book.state"] }],
      ["an empty entry", { emits: [""] }],
    ] as [string, unknown][])
      it(`${name} is R1 generic`, () => expect(triples(run([fx("BORROW", "rows/0", value)]))).toContainEqual(["R1", "generic", EK]));

    it("an unknown key in effects is left to the schema: R1 reports only the undeclared entry", () =>
      expect(triples(run([fx("BORROW", "rows/0", { writes: [], emits: ["loan.returned"] })]))).toEqual([["R1", "effect_not_declared", `${EK}.emits.loan.returned`]]));
  });

  describe("R5: create_rule per row", () => {
    const rule = (extra: object = {}): Op => ({
      op: "add", path: "/linkTypes/0/create_rule",
      value: { context: "Circulation", with_creates: ["Loan", "Member"], cite: { doc: "L3", quote: "The Loan refers to the Book by book_id" }, ...extra },
    });
    const createsBoth: Op = { op: "replace", path: "/actionTypes/BORROW/creates", value: ["Loan", "Member"] };

    it("a row that creates the link's from without each with_creates object is R5", () => {
      expect(only("R5", run([rule(), createsBoth, fx("BORROW", "otherwise", { creates: ["Loan"] }), fx("BORROW", "rows/0", {})]))).toEqual([
        ["R5", "generic", "BORROW:otherwise:loan_book"],
      ]);
      expect(only("R5", run([rule(), createsBoth, fx("BORROW", "otherwise", { creates: ["Loan", "Member"] })]))).toEqual([]);
    });

    it("the row check runs apart from the action check", () => {
      const keys = only("R5", run([rule(), fx("BORROW", "otherwise", { creates: ["Loan"] })])).map(([, , k]) => k);
      expect(keys.sort()).toEqual(["BORROW:loan_book", "BORROW:otherwise:loan_book"]);
    });

    it("an action in exceptions.commands is not checked per row", () => {
      const exc = rule({ exceptions: { commands: ["BORROW"], cite: { doc: "L3", quote: "The Loan refers to the Book by book_id" } } });
      expect(only("R5", run([exc, createsBoth, fx("BORROW", "otherwise", { creates: ["Loan"] })]))).toEqual([]);
    });
  });

  describe("R11: materialization per row", () => {
    it("a row that creates an input object without the materialized property in its edits is R11", () => {
      expect(only("R11", run([fx("BORROW", "otherwise", { creates: ["Loan"], edits: ["Book.state"] })]))).toEqual([
        ["R11", "materialization_missing", "BORROW:otherwise:Member.open_loans"],
      ]);
      expect(only("R11", run([fx("BORROW", "otherwise", { creates: ["Loan"], edits: ["Book.state", "Member.open_loans"] })]))).toEqual([]);
    });

    it("a row that edits an input without the materialized property is R11", () =>
      expect(only("R11", run([fx("RETURN", "rows/1", { edits: ["Loan.state", "Book.state"] })]))).toEqual([
        ["R11", "materialization_missing", "RETURN:rows.1:Member.open_loans"],
      ]));

    it("a row that deletes an input object is R11, unless it deletes the target's object too", () => {
      const deletes: Op = { op: "add", path: "/actionTypes/RETURN/deletes", value: ["Loan", "Member"] };
      expect(only("R11", run([deletes, fx("RETURN", "rows/1", { deletes: ["Loan"] })]))).toEqual([
        ["R11", "materialization_missing", "RETURN:rows.1:Member.open_loans"],
      ]);
      expect(only("R11", run([deletes, fx("RETURN", "rows/1", { deletes: ["Loan", "Member"] })]))).toEqual([]);
    });
  });

  describe("R12: rows with the same result and different effects", () => {
    // rows 0 and 1 of BORROW (both REJECTED) with their cites swapped: out of source order
    const swap: Op[] = [
      { op: "replace", path: "/actionTypes/BORROW/decision/rows/0/cites", value: ont.actionTypes.BORROW.decision.rows[1].cites },
      { op: "replace", path: "/actionTypes/BORROW/decision/rows/1/cites", value: ont.actionTypes.BORROW.decision.rows[0].cites },
    ];

    it("out of source order is row_order_mismatch only when the effects differ", () => {
      expect(triples(run(swap))).toEqual([]);
      expect(triples(run([...swap, fx("BORROW", "rows/1", {})]))).toEqual([["R12", "row_order_mismatch", "BORROW:rows.0:rows.1"]]);
    });

    it("rows whose effects are equal as sets do not differ", () => {
      expect(triples(run([...swap, fx("BORROW", "rows/0", {}), fx("BORROW", "rows/1", {})]))).toEqual([]);
      expect(triples(run([...swap, fx("BORROW", "rows/0", {}), fx("BORROW", "rows/1", { edits: [] })]))).toEqual([]);
    });

    it("a row without effects compares as the action lists", () => {
      const bound = { creates: ["Loan"], edits: ["Member.open_loans", "Book.state"], emits: ["loan.created"], links: ["loan_branch", "loan_book", "loan_member"] };
      expect(triples(run([...swap, fx("BORROW", "rows/1", bound)]))).toEqual([]);
    });

    it("when the action lists are all empty, a row without effects and a row with {} do not differ", () => {
      const none = (n: string) => ({ none: n });
      const empty: Op[] = [
        { op: "remove", path: "/actionTypes/BORROW/creates" },
        { op: "remove", path: "/actionTypes/BORROW/edits" },
        { op: "remove", path: "/actionTypes/BORROW/emits" },
        { op: "replace", path: "/actionTypes/BORROW/link_effects", value: { loan_book: none("x"), loan_member: none("x"), loan_branch: none("x"), member_person: none("x") } },
      ];
      expect(only("R12", run([...empty, ...swap, fx("BORROW", "rows/1", {})]))).toEqual([]);
    });

    it("rows with one result and different effects, and no order cite, are row_order_uncited", () => {
      const uncited: Op[] = [
        { op: "remove", path: "/actionTypes/BORROW/decision/order" },
        { op: "remove", path: "/actionTypes/BORROW/decision/rows/3" },
      ];
      expect(triples(run(uncited))).toEqual([]);
      expect(triples(run([...uncited, fx("BORROW", "rows/2", {})]))).toEqual([["R12", "row_order_uncited", "BORROW"]]);
    });
  });

  describe("query", () => {
    const stated = { edits: [], creates: ["Loan"], deletes: [], emits: ["loan.created"], links: [] };

    it("rows without effects give null and effectsUpperBound false", () => {
      const a = queryAction(ont, "BORROW")!;
      expect(a.decision!.rows.map((r) => r.effects)).toEqual([null, null, null, null, null]);
      expect(a.effectsUpperBound).toBe(false);
    });

    it("a row with effects gives all five kinds, and effectsUpperBound true", () => {
      const o = applyPatch(ont, [fx("BORROW", "otherwise", { creates: ["Loan"], emits: ["loan.created"] })]);
      const a = queryAction(o, "BORROW")!;
      expect(a.decision!.rows.find((r) => r.row === "otherwise")!.effects).toEqual(stated);
      expect(a.decision!.rows.filter((r) => r.row !== "otherwise").map((r) => r.effects)).toEqual([null, null, null, null]);
      expect(a.effectsUpperBound).toBe(true);
      expect(queryDisposition(o, "BORROWED")!.rows[0].effects).toEqual(stated);
    });
  });
});
