// The scalar type `number` (a finite IEEE 754 double) and R4 number literals found by value (SPEC section 9, "Literals in quotes").
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
import { decide } from "../src/evaluate";
import { checkPredicate, SCALAR_TYPE_NAMES, type Stage1Ontology } from "../src/expr";
import { applyPatch, type Op } from "../src/patch";
import { projectSnapshot } from "../src/reconcile";
import { quoteHasLiteral } from "../src/stage1-check";
import { mayUnknown } from "../src/unknown";

// a toy ontology: one action A over a Box, with the condition c; a passing c gives OK, else NO
const toy = (cond: unknown, params: Record<string, unknown> = {}): Stage1Ontology => ({
  dispositions: { OK: { class: "applied" }, NO: { class: "rejected" } },
  objectTypes: { Box: { datasource: "boxes", properties: { qty: { type: "number" }, n: { type: "integer" } } } },
  linkTypes: [],
  actionTypes: { A: { parameters: { b: { type: { ref: "Box" } }, ...(params as any) }, permission: { keys: [] }, conditions: [{ id: "c", expr: cond as any }], decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "OK" }], otherwise: { result: "NO" } } } },
});
const run = (cond: unknown, params: Record<string, unknown>, bind: Record<string, unknown>, box: Record<string, unknown> = {}) =>
  decide(toy(cond, params), "A", { objects: { Box: [{ id: "b1", qty: null, n: 1, ...box }] } } as any, null, { b: "b1", ...bind } as any, { id: "u", keys: [], kind: "person" } as any, 0);
const res = (r: any) => (r.layer === "domain" ? r.result : `${r.result}:${r.reason}`);
const typeError = (cond: unknown, params: Record<string, unknown> = {}) => () => checkPredicate(toy(null, params), cond, { action: "A", locals: {} });

describe("quoteHasLiteral", () => {
  // [literal, quote, found]
  const rows: [string | number, string, boolean][] = [
    [5, "5 kg", true], [5, "5.0 kg", true], [2.5, "2.50 kg", true], [5, "2.5 kg", false], [5, "-5 degrees", false], [-5, "-5 degrees", true],
    [7, "1e-7", false], [7, "v1e-7", false], [5, "No.5", false], [5, "05", false], [-5, "−5 degrees", true], [5, "−5 degrees", false],
    [5, "5-7 days", true], [7, "5-7 days", true], [1000, "more than 1000.", true], [2.5, "the limit is 2.5.", true], [5, "5+ years", true],
    [18, "18+", true], [2.5, "最多2.5公斤", true], [8, "UTC+8", false], [5, "5−7 days", true], [1, "1,000", false], [0, "1,000", false],
    [1, "values 1,2,3", true], [2, "values 1,2,3", true], [5, "5–7 days", true], [5, "(5)", true], [5, "5%", true], [5, "x=5", true],
    [3, "version 1.2.3", false], [1e21, "1e21", true], [0.5, "v0.5", false], [7, "agent 007", false], [0, "0.0", true], [5, "+5 °C", true],
    [-7, "1e−7", false], [1e-7, "1e−7", true], [1000, "more than 1000", true],
    [1000, "1,000", false], [1000000, "1,000,000", false], [100, "x,100", true], [7, "1e-7.5", false], [7.5, "1e-7.5", false], [5, "5kg", false],
    [2, "2.5", false], [1, "1.0", true], ["M-9", "rule M-9 applies", true], ["", "x", false], ["5", "2.5", true], [-0, "0", true], [0, "-0", true],
    [5, "a_-5", false],
    [5, "at most −.5 kg", false], [0.5, "at most .5 kg", false], [5, "a 5-year period", true], [5, "a 5–7-day window", true], [7, "a 5–7-day window", true],
    [7, "a 7-day window", true], [19, "COVID-19", false], [5, "5-7-day", true], [7, "5-7-day", true], [2, "Fig. 2", true], [2, "Fig.2", false],
    [1.5, "version 1.5.x", false], [5, "5.x", false], [0.5, "a rate of .5%", false], [5, ".5%", false], [14, "a 14-day window", true],
    [18, "an 18-year-old member", true], [24, "24-hour notice", true], [2, "Tier-2", false], [5, "a 5-star rating", true], [2.5, "2.5.", true], [3, "e.g. 3 items", true],
  ];
  it("has 74 rows", () => expect(rows.length).toBe(74));
  for (const [x, q, found] of rows) it(`${JSON.stringify(x)} in ${JSON.stringify(q)}: ${found}`, () => expect(quoteHasLiteral(q, x)).toBe(found));
});

describe("number: types and decide", () => {
  const d = { d: { type: "number", optional: true } };
  it("lt, lte over a number parameter and a number property", () => {
    expect(res(run({ lt: [{ ref: "d" }, { lit: 2.5 }] }, d, { d: 1.25 }))).toBe("OK");
    expect(res(run({ lt: [{ ref: "d" }, { lit: 2.5 }] }, d, { d: 2.5 }))).toBe("NO");
    expect(res(run({ lte: [{ ref: "b.qty" }, { lit: 3 }] }, {}, {}, { qty: 2.5 }))).toBe("OK");
  });
  it("a number parameter value that is not a finite number is INVALID_BINDING type; -0 fits", () => {
    const p = { w: { type: "number" } };
    for (const w of ["2.5", NaN, Infinity, -Infinity]) expect(run({ isNotNull: [{ ref: "w" }] }, p, { w })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "w", reason: "type" });
    expect(res(run({ isNotNull: [{ ref: "w" }] }, p, { w: -0 }))).toBe("OK");
  });
  it("a snapshot string for a number property throws", () => expect(() => run({ lte: [{ ref: "b.qty" }, { lit: 3 }] }, {}, {}, { qty: "2.5" })).toThrow(/does not fit its declared type/));
  it("{set: number}: in with a set literal", () => expect(res(run({ in: [{ ref: "d" }, { lit: [0.5, 1] }] }, d, { d: 0.5 }))).toBe("OK"));
  it("integer and number are two types", () => {
    expect(typeError({ lt: [{ ref: "b.n" }, { ref: "b.qty" }] })).toThrow("lt needs two operands of one type among timestamp, date, duration, integer, number; found integer and number");
    expect(typeError({ eq: [{ ref: "b.n" }, { ref: "b.qty" }] })).toThrow("eq compares integer with number");
    expect(typeError({ lt: [{ ref: "b.n" }, { lit: 2.5 }] })).toThrow("literal 2.5 does not fit integer");
    expect(typeError({ lt: [{ ref: "b.qty" }, { lit: 2 }] })).not.toThrow();
    expect(typeError({ lt: [{ plus: [{ ref: "b.qty" }, { lit: 1 }] }, { ref: "b.qty" }] })).toThrow("$.lt[0].plus[0]: expected timestamp, found number");
  });
  it("a comparison with an absent optional number parameter may be UNKNOWN; isNotNull may not", () => {
    expect(mayUnknown(toy(null, d), { lt: [{ ref: "d" }, { lit: 1 }] }, (x) => x === "d")).toBe(true);
    expect(mayUnknown(toy(null, d), { isNotNull: [{ ref: "d" }] }, (x) => x === "d")).toBe(false);
  });
  it("projectSnapshot decodes a number column", () => {
    const o: Stage1Ontology = { objectTypes: { T: { datasource: "t", properties: { q: { type: "number" } } } }, linkTypes: [], actionTypes: {} };
    const decode = (raw: unknown) => (typeof raw === "string" && raw !== "abc" ? Number(raw) : raw) as any;
    expect(projectSnapshot(o, { t: [{ id: "1", q: "2.50" }] }, decode)).toEqual({ snapshot: { objects: { T: [{ id: "1", q: 2.5 }] } }, defects: [] });
    expect(projectSnapshot(o, { t: [{ id: "1", q: "abc" }] }, decode).defects).toEqual([{ object: "T", prop: "q", row: "1", value: "abc" }]);
  });
});

describe("number: schema", () => {
  const schema = JSON.parse(schemaText);
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  it("the set element types are the scalar type names plus string", () =>
    expect(new Set(schema.$defs.valueType.oneOf[2].properties.set.oneOf[0].enum)).toEqual(new Set([...SCALAR_TYPE_NAMES, "string"])));
  it("a number type and number literals validate", () => {
    const o = parse(ontologyText);
    o.objectTypes.Book.properties.weight = { class: "canonical", type: "number", cite: { doc: "L1", quote: "x" } };
    o.actionTypes.RETURN.parameters.w = { type: { set: "number" }, optional: true, cite: { doc: "L6", quote: "x" } };
    o.actionTypes.RETURN.conditions.push({ id: "p", expr: { lt: [{ ref: "x" }, { lit: 2.5 }] }, cites: [{ cite: { doc: "L6", quote: "x" } }] });
    o.actionTypes.RETURN.conditions.push({ id: "q", expr: { in: [{ ref: "x" }, { lit: [2, 2.5] }] }, cites: [{ cite: { doc: "L6", quote: "x" } }] });
    expect(validate(o), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("number: R4 finds a number literal by value", () => {
  const ont = parse(ontologyText);
  const facts = () => buildLibraryFacts(doc, libraryEvidence(), config);
  const lits = (r: ReturnType<typeof check>) => r.violations.filter((x) => x.kind === "literal_unsupported").map((x) => x.key);
  // the three places R4 checks literals: a condition, a permission conditional_when, a derived property
  const inCondition = (type: string, lit: number, quote: string) => check(applyPatch(ont, [
    { op: "add", path: "/actionTypes/RETURN/parameters/weight", value: { type, optional: true, cite: { doc: "L6", quote: "RETURN takes loan_id" } } },
    { op: "add", path: "/actionTypes/RETURN/conditions/-", value: { id: "light", expr: { lt: [{ ref: "weight" }, { lit }] }, cites: [{ cite: { doc: "L6", quote } }] } },
  ] as Op[]), facts());
  const inWhen = (lit: number, quote: string) => check(applyPatch(ont, [
    { op: "add", path: "/actionTypes/BORROW/parameters/weight", value: { type: "integer", optional: true, cite: { doc: "L6", quote: "BORROW takes book_id" } } },
    { op: "replace", path: "/actionTypes/BORROW/permission", value: { keys: ["loan:create"], cite: { doc: "L10", quote: "`loan:create`" }, conditional_keys: ["loan:close"], conditional_cite: { doc: "L10", quote }, conditional_when: { lt: [{ ref: "weight" }, { lit }] } } },
  ] as Op[]), facts());
  const inDerived = (lit: number, quote: string) => check(applyPatch(ont, [
    { op: "add", path: "/objectTypes/Loan/properties/fee", value: { class: "canonical", type: "integer", cite: { doc: "L3", quote: "due_date is set by BORROW." } } },
    { op: "add", path: "/derivedProperties/cheap", value: { of: "Loan", type: "boolean", expr: { lt: [{ ref: "self.fee" }, { lit }] }, cite: { doc: "L3", quote } } },
  ] as Op[]), facts());
  it("a number type passes R1, and {lit: 2.5} is found in \"2.50\"", () => {
    const r = inCondition("number", 2.5, "at most 2.50 kg");
    expect(r.violations.filter((x) => x.rule === "R1")).toEqual([]);
    expect(lits(r)).toEqual([]);
  });
  it("{lit: 2.5} is not found in \"25\"", () => expect(lits(inCondition("number", 2.5, "at most 25 kg"))).toEqual(["RETURN:light:2.5"]));
  it("an integer literal that is only a part of a number is not found: condition, conditional_when, derived property", () => {
    expect(lits(inCondition("integer", 5, "at most 2.5 kg"))).toEqual(["RETURN:light:5"]);
    expect(lits(inWhen(5, "at most 2.5 kg"))).toEqual(["BORROW:conditional_when:5"]);
    expect(lits(inDerived(5, "at most 2.5 kg"))).toEqual(["derivedProperties.cheap:5"]);
  });
  it("an integer literal that is a whole number of the quote is found: condition, conditional_when, derived property", () => {
    expect(lits(inCondition("integer", 5, "at most 5 kg"))).toEqual([]);
    expect(lits(inWhen(5, "at most 5 kg"))).toEqual([]);
    expect(lits(inDerived(5, "at most 5 kg"))).toEqual([]);
  });
});
