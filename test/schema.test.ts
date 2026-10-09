// JSON Schema for the ontology YAML: the toy ontology validates; shape errors are rejected.
// The schema covers shape (including unknown keys) and field descriptions; rules R1–R12 stay in src/checker.ts.
// A file conforms only when it validates here AND the checker reports no unwaived violation (SPEC.md section 1).
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import schemaText from "../ontology.schema.json?raw";
import toyText from "../examples/library/library.ontology.yaml?raw";
import { EXPR_NODES, SCALAR_TYPE_NAMES } from "../src/expr";

const schema = JSON.parse(schemaText);
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const ontology = parse(toyText);
const alt = (k: string) => ({ keys: [k], cite: { doc: "L10", quote: "x" } });
const paths = () => (validate.errors ?? []).map((e) => e.instancePath);
// A condition with only hand-written reads (no expression), appended to an action to probe the reads shapes.
const probe = (reads: unknown[]) => ({ id: "reads_probe", unspecified: "probe", reads, cites: [{ cite: { doc: "L6", quote: "x" } }] });
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("ontology JSON Schema", () => {
  it("the YAML names the schema on its first line", () =>
    expect(toyText.split("\n")[0]).toBe("# yaml-language-server: $schema=../../ontology.schema.json"));

  it("the toy library ontology validates", () => {
    const ok = validate(ontology);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("evidence has no enum: any non-empty string validates", () => {
    const o = structuredClone(ontology);
    o.actionTypes.BORROW.evidence = "anyEvidenceId";
    expect(validate(o)).toBe(true);
  });

  it("crossContext {unspecified, cite} validates", () => {
    const o = structuredClone(ontology);
    o.actionTypes.BORROW.crossContext = { unspecified: "x", cite: o.actionTypes.BORROW.crossContext.cite };
    expect(validate(o)).toBe(true);
  });

  it("permission any_of with two alternatives validates", () => {
    const o = structuredClone(ontology);
    o.actionTypes.BORROW.permission = { any_of: [alt("a:b"), alt("c:d")] };
    expect(validate(o)).toBe(true);
  });

  it("parameters and parameter / actor reads validate", () => {
    const o = structuredClone(ontology);
    const c = o.actionTypes.RETURN;
    c.parameters = { loan_id: { cite: { doc: "L6", quote: "x" } } };
    c.conditions.push(probe([{ actor: "id" }, { prop: "Loan.state", values: ["ACTIVE"] }, { param: "loan_id" }, { param: "loan_id", values: ["1"] }, { actor: "keys" }]));
    const ok = validate(o);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("permission principals {kinds, cite} and an optional parameter validate", () => {
    const o = structuredClone(ontology);
    o.actionTypes.BORROW.permission.principals = { kinds: ["person"], cite: { doc: "L6", quote: "The caller of an action is a Person." } };
    o.actionTypes.BORROW.parameters.book_id.optional = true;
    const ok = validate(o);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("permission principals on the {none} form validate", () => {
    const o = structuredClone(ontology);
    o.actionTypes.RETURN.permission = {
      none: "anyone may return a loan",
      cite: { doc: "L10", quote: "`loan:close`" },
      principals: { kinds: ["person"], cite: { doc: "L6", quote: "The caller of an action is a Person." } },
    };
    const ok = validate(o);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("the expression node names and the value type names are the evaluator's", () => {
    expect(Object.keys(schema.$defs)).toEqual(expect.arrayContaining(["valueType", "expr"]));
    const vt = schema.$defs.valueType;
    const names = [vt, ...(vt.oneOf ?? vt.anyOf ?? [])].flatMap((b: any) => (Array.isArray(b.enum) ? b.enum : []));
    expect(sorted(names)).toEqual(sorted(SCALAR_TYPE_NAMES));
    expect(sorted(Object.keys(schema.$defs.expr.properties))).toEqual(sorted(EXPR_NODES));
  });

  const reject: [string, (o: any) => void, string][] = [
    ["class outside the enum", (o) => (o.objectTypes.Book.properties.state.class = "foo"), "/objectTypes/Book/properties/state/class"],
    ["unknown field on an object", (o) => (o.objectTypes.Book.colour = "red"), "/objectTypes/Book"],
    ["unknown field on a command", (o) => (o.actionTypes.BORROW.note = "x"), "/actionTypes/BORROW"],
    ["unknown field on a link", (o) => (o.linkTypes[0].label = "x"), "/linkTypes/0"],
    ["unknown field in a cite", (o) => (o.actionTypes.BORROW.permission.cite.page = 3), "/actionTypes/BORROW/permission/cite"],
    ["unknown top-level field", (o) => (o.extra = 1), ""],
    ["link effect with two kinds", (o) => (o.actionTypes.RETURN.link_effects.loan_member.effect = "x"), "/actionTypes/RETURN/link_effects/loan_member"],
    ["canonical property without cite", (o) => delete o.objectTypes.Book.properties.state.cite, "/objectTypes/Book/properties/state"],
    ["unknown field on a state machine", (o) => (o.stateMachines.Book.colour = "x"), "/stateMachines/Book"],
    ["crossContext with both via and unspecified", (o) => (o.actionTypes.BORROW.crossContext.unspecified = "x"), "/actionTypes/BORROW/crossContext"],
    ["unknown field in crossContext", (o) => (o.actionTypes.BORROW.crossContext.extra = true), "/actionTypes/BORROW/crossContext"],
    ["empty context name", (o) => (o.contexts[""] = Object.values(o.contexts)[0]), "/contexts"],
    ["empty object type name", (o) => (o.objectTypes[""] = o.objectTypes.Book), "/objectTypes"],
    ["empty action name", (o) => (o.actionTypes[""] = o.actionTypes.BORROW), "/actionTypes"],
    ["empty property name", (o) => (o.objectTypes.Book.properties[""] = o.objectTypes.Book.properties.state), "/objectTypes/Book/properties"],
    ["empty link effect name", (o) => (o.actionTypes.BORROW.link_effects[""] = o.actionTypes.BORROW.link_effects.loan_book), "/actionTypes/BORROW/link_effects"],
    ["any_of with one alternative", (o) => (o.actionTypes.BORROW.permission = { any_of: [alt("a:b")] }), "/actionTypes/BORROW/permission/any_of"],
    ["any_of alternative with none", (o) => { o.actionTypes.BORROW.permission = { any_of: [alt("a:b"), { none: "x", cite: alt("a").cite }] }; }, "/actionTypes/BORROW/permission/any_of/1"],
    ["any_of alternative with an unknown field", (o) => { o.actionTypes.BORROW.permission = { any_of: [alt("a:b"), { ...alt("c:d"), note: "x" }] }; }, "/actionTypes/BORROW/permission/any_of/1"],
    ["any_of with an extra sibling key", (o) => { o.actionTypes.BORROW.permission = { any_of: [alt("a:b"), alt("c:d")], keys: ["x"] }; }, "/actionTypes/BORROW/permission"],
    ["actor outside the enum", (o) => o.actionTypes.BORROW.conditions.push(probe([{ actor: "groups" }])), "/actionTypes/BORROW/conditions/4/reads/0"],
    ["parameter read with an unknown field", (o) => o.actionTypes.BORROW.conditions.push(probe([{ param: "x", prop: "Book.state" }])), "/actionTypes/BORROW/conditions/4/reads/0"],
    ["parameter read with empty values", (o) => o.actionTypes.BORROW.conditions.push(probe([{ param: "x", values: [] }])), "/actionTypes/BORROW/conditions/4/reads/0"],
    ["actor read with values", (o) => o.actionTypes.BORROW.conditions.push(probe([{ actor: "keys", values: ["a"] }])), "/actionTypes/BORROW/conditions/4/reads/0"],
    ["parameter without cite", (o) => (o.actionTypes.RETURN.parameters = { x: {} }), "/actionTypes/RETURN/parameters/x"],
    ["parameter with an unknown field", (o) => (o.actionTypes.RETURN.parameters = { x: { cite: { doc: "L6", quote: "x" }, note: "x" } }), "/actionTypes/RETURN/parameters/x"],
    ["empty parameter name", (o) => (o.actionTypes.RETURN.parameters = { "": { cite: { doc: "L6", quote: "x" } } }), "/actionTypes/RETURN/parameters"],
    ["condition with both expr and unspecified", (o) => (o.actionTypes.BORROW.conditions[0].unspecified = "x"), "/actionTypes/BORROW/conditions/0"],
    ["condition with empty cites", (o) => (o.actionTypes.BORROW.conditions[0].cites = []), "/actionTypes/BORROW/conditions/0/cites"],
    ["expr condition with reads", (o) => (o.actionTypes.BORROW.conditions[0].reads = [{ actor: "id" }]), "/actionTypes/BORROW/conditions/0"],
    ["principals without cite", (o) => (o.actionTypes.BORROW.permission.principals = { kinds: ["person"] }), "/actionTypes/BORROW/permission/principals"],
    ["principals as a list (old shape)", (o) => (o.actionTypes.BORROW.permission.principals = ["person"]), "/actionTypes/BORROW/permission/principals"],
    ["principals without cite on {none}", (o) => (o.actionTypes.RETURN.permission = { none: "anyone may return a loan", cite: { doc: "L10", quote: "`loan:close`" }, principals: { kinds: ["person"] } }), "/actionTypes/RETURN/permission/principals"],
    ["scope.global item without cite", (o) => (o.scope.global[0] = { type: "Person" }), "/scope/global/0"],
    ["expr node with two keys", (o) => (o.actionTypes.BORROW.conditions[0].expr = { eq: [{ ref: "now" }, { ref: "now" }], neq: [{ ref: "now" }, { ref: "now" }] }), "/actionTypes/BORROW/conditions/0/expr"],
  ];
  for (const [name, mutate, path] of reject)
    it(`rejects: ${name}`, () => {
      const o = structuredClone(ontology);
      mutate(o);
      expect(validate(o)).toBe(false);
      expect(paths()).toContain(path);
    });

  it("(g) idempotencyKey {required, cite} validates; without a cite it is rejected", () => {
    const o = structuredClone(ontology);
    o.actionTypes.BORROW.idempotencyKey = { required: true, cite: { doc: "L6", quote: "BORROW takes book_id" } };
    expect(validate(o)).toBe(true);
    o.actionTypes.BORROW.idempotencyKey = { required: true };
    expect(validate(o)).toBe(false);
  });

  it("(h) values on an enum parameter validates; on a non-enum, empty, repeated or untyped parameter it is rejected", () => {
    const o = structuredClone(ontology);
    const quote = { doc: "L3", quote: "RETURN records the return_condition of the Loan: GOOD or DAMAGED." };
    o.actionTypes.BORROW.parameters.return_condition = { type: "enum", values: ["GOOD", "DAMAGED"], optional: true, cite: quote };
    expect(validate(o)).toBe(true);
    const rejects = (mutate: (x: any) => void) => {
      const x = structuredClone(o);
      mutate(x);
      return validate(x);
    };
    expect(rejects((x) => (x.actionTypes.BORROW.parameters.member_id.values = ["GOOD"]))).toBe(false);
    expect(rejects((x) => (x.actionTypes.BORROW.parameters.return_condition.values = []))).toBe(false);
    expect(rejects((x) => (x.actionTypes.BORROW.parameters.return_condition.values = ["GOOD", "GOOD"]))).toBe(false);
    expect(rejects((x) => delete x.actionTypes.BORROW.parameters.return_condition.type)).toBe(false);
    expect(rejects((x) => (x.actionTypes.BORROW.parameters.return_condition.type = { set: "enum" }))).toBe(false);
  });
});
