// The scalar type `string`: a value read only by isNull / isNotNull (SPEC section 9, "Types and values").
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import schemaText from "../ontology.schema.json?raw";
import { decide } from "../src/evaluate";
import { checkPredicate, derivedPropertyType, SCALAR_TYPE_NAMES, type Stage1Ontology } from "../src/expr";
import { projectSnapshot } from "../src/reconcile";

// a toy ontology: one action A over a Box, with the condition c; a passing c gives OK, else NO
const toy = (cond: unknown, params: Record<string, unknown> = {}): Stage1Ontology => ({
  dispositions: { OK: { class: "applied" }, NO: { class: "rejected" } },
  objectTypes: { Box: { datasource: "boxes", properties: { note: { type: "string" } } } },
  linkTypes: [],
  actionTypes: { A: { parameters: { b: { type: { ref: "Box" } }, ...(params as any) }, permission: { keys: [] }, conditions: [{ id: "c", expr: cond as any }], decision: { hitPolicy: "first", rows: [{ when: { passes: "c" }, result: "OK" }], otherwise: { result: "NO" } } } },
});
const run = (cond: unknown, params: Record<string, unknown>, bind: Record<string, unknown>, box: Record<string, unknown> = {}) =>
  decide(toy(cond, params), "A", { objects: { Box: [{ id: "b1", note: null, ...box }] } } as any, null, { b: "b1", ...bind } as any, { id: "u", keys: [], kind: "person" } as any, 0);
const res = (r: any) => (r.layer === "domain" ? r.result : `${r.result}:${r.reason}`);
const s = { s: { type: "string", optional: true } };
const typeError = (cond: unknown) => () => checkPredicate(toy(null, s), cond, { action: "A", locals: {} });

describe("string: decide", () => {
  it("isNotNull over a string parameter; \"\" is a value", () => {
    expect(res(run({ isNotNull: [{ ref: "s" }] }, s, { s: "" }))).toBe("OK");
    expect(res(run({ isNotNull: [{ ref: "s" }] }, s, {}))).toBe("NO");
    expect(run({ isNotNull: [{ ref: "s" }] }, s, { s: 5 })).toEqual({ layer: "invocation", result: "INVALID_BINDING", param: "s", reason: "type" });
  });
  it("isNull over a string property", () => {
    expect(res(run({ isNull: [{ ref: "b.note" }] }, {}, {}, { note: "x" }))).toBe("NO");
    expect(res(run({ isNull: [{ ref: "b.note" }] }, {}, {}))).toBe("OK");
  });
  it("projectSnapshot keeps a string value and reports a value that is not a string", () => {
    const o: Stage1Ontology = { objectTypes: { T: { datasource: "t", properties: { n: { type: "string" } } } }, linkTypes: [], actionTypes: {} };
    expect(projectSnapshot(o, { t: [{ id: "1", n: "hi" }] }, (raw) => raw as any)).toEqual({ snapshot: { objects: { T: [{ id: "1", n: "hi" }] } }, defects: [] });
    expect(projectSnapshot(o, { t: [{ id: "1", n: 5 }] }, (raw) => raw as any).defects).toEqual([{ object: "T", prop: "n", row: "1", value: 5 }]);
  });
});

describe("string: only isNull and isNotNull read it", () => {
  it("a comparison with a string operand is a type error", () => {
    expect(typeError({ eq: [{ ref: "s" }, { ref: "b.note" }] })).toThrow("eq on a string; a string is read only by isNull and isNotNull");
    expect(typeError({ lt: [{ ref: "s" }, { ref: "b.note" }] })).toThrow("lt on a string; a string is read only by isNull and isNotNull");
  });
  it("a literal in a string position is a type error", () => expect(typeError({ eq: [{ ref: "s" }, { lit: "x" }] })).toThrow("there are no string literals; a string is read only by isNull and isNotNull"));
  it("in with a string element is a type error", () => expect(typeError({ in: [{ ref: "s" }, { ref: "actor.keys" }] })).toThrow("in on a string; a string is read only by isNull and isNotNull"));
  it("a string literal is still an element of {set: string}", () => {
    expect(typeError({ in: [{ lit: "k" }, { ref: "actor.keys" }] })).not.toThrow();
    expect(typeError({ subsetOf: [{ ref: "actor.keys" }, { lit: ["a", "b"] }] })).not.toThrow();
  });
  it("a derived property of type string with a literal root is a type error", () => {
    const o = { ...toy(null), derivedProperties: { label: { of: "Box", type: "string", expr: { lit: "x" } } } } as Stage1Ontology;
    expect(() => derivedPropertyType(o, "label")).toThrow(/there are no string literals/);
  });
});

describe("string: schema", () => {
  const schema = JSON.parse(schemaText);
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  it("string is a scalar type name, and the set element types are the scalar type names", () => {
    expect(SCALAR_TYPE_NAMES).toEqual(["enum", "timestamp", "duration", "date", "timezone", "id", "integer", "number", "boolean", "string"]);
    expect(schema.$defs.valueType.oneOf[2].properties.set.oneOf[0].enum).toEqual([...SCALAR_TYPE_NAMES]);
  });
  it("a string property and a string parameter validate", () => {
    const o = parse(ontologyText);
    o.objectTypes.Member.properties.note = { class: "canonical", type: "string", cite: { doc: "L2", quote: "x" } };
    o.actionTypes.RETURN.parameters.memo = { type: "string", optional: true, cite: { doc: "L6", quote: "x" } };
    expect(validate(o), JSON.stringify(validate.errors)).toBe(true);
  });
});
