// A property projected from one top-level key of a JSON column (`properties.<p>.from: {field, key}`): schema, R1, R2,
// R11, query, projectSnapshot, the static UNKNOWN analysis and decide. Each checker case patches the clean toy library.
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import schemaText from "../ontology.schema.json?raw";
import specText from "../SPEC.md?raw";
import { check } from "../src/checker";
import { decide, evalPredicate, type Snapshot } from "../src/evaluate";
import type { Expr, Stage1Ontology } from "../src/expr";
import { applyPatch, type Op } from "../src/patch";
import { queryObject, queryReads, queryWrites } from "../src/query";
import { projectSnapshot, type Decode } from "../src/reconcile";
import { buildLibraryFacts } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";

const ont = parse(ontologyText);
const STATE_LINE = "The state of a Book is AVAILABLE, ON_LOAN or WITHDRAWN.";
const META = "The metadata_json of a Book holds its pages.";
const mq = { doc: "L1", quote: META };
// the toy source with the JSON column metadata_json on Book (and extra field lines)
const docWith = (...extra: string[]) => {
  expect(doc).toContain("- title\n- state\n```");
  expect(doc).toContain(STATE_LINE);
  return doc.replace("- title\n- state\n```", ["- title", "- state", "- metadata_json", ...extra, "```"].join("\n")).replace(STATE_LINE, `${STATE_LINE}\n${META}`);
};
const pagesProp = { class: "canonical", type: "integer", from: { field: "metadata_json", key: "pages" }, cite: mq };
const base: Op[] = [
  { op: "add", path: "/objectTypes/Book/properties/metadata_json", value: { class: "canonical", cite: mq } },
  { op: "add", path: "/objectTypes/Book/properties/pages", value: pagesProp },
];
const run = (ops: Op[], source = docWith()) => check(applyPatch(ont, [...base, ...ops]), buildLibraryFacts(source, libraryEvidence(), config));
const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
const r1 = (r: ReturnType<typeof check>) => r.violations.filter((x) => x.rule === "R1").map((x) => [x.key, x.msg]);
const pages = (value: unknown): Op => ({ op: "replace", path: "/objectTypes/Book/properties/pages", value });
const FROM = "objectTypes.Book.properties.pages.from";

describe("properties.<p>.from", () => {
  it("T1 schema: from validates; an unknown key, an empty or a missing field / key is rejected", () => {
    const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(schemaText));
    const o = structuredClone(applyPatch(ont, base));
    expect(validate(o), JSON.stringify(validate.errors)).toBe(true);
    for (const bad of [{ field: "metadata_json", key: "pages", path: "x" }, { field: "metadata_json" }, { field: "", key: "pages" }, { field: "metadata_json", key: "" }]) {
      o.objectTypes.Book.properties.pages.from = bad;
      expect(validate(o), JSON.stringify(bad)).toBe(false);
      expect((validate.errors ?? []).map((e) => e.instancePath)).toContain("/objectTypes/Book/properties/pages/from" + (bad.field === "" ? "/field" : bad.key === "" ? "/key" : ""));
    }
  });

  it("the toy with a projected property passes, without a field line for it", () => expect(triples(run([]))).toEqual([]));

  describe("T2 R1", () => {
    it("from without a non-empty field and key", () => {
      for (const from of [{ field: "metadata_json" }, { field: "", key: "pages" }, "metadata_json.pages"])
        expect(r1(run([pages({ ...pagesProp, from })]))).toEqual([[FROM, "needs field and key"]]);
    });
    it("no type", () => {
      const { type: _t, ...untyped } = pagesProp;
      expect(r1(run([pages(untyped)]))).toEqual([[FROM, "needs type"]]);
    });
    it("a field that is not declared, has a type or has from", () => {
      const msg = "field must name a declared property of Book that has neither from nor type";
      expect(r1(run([pages({ ...pagesProp, from: { field: "nope", key: "pages" } })]))).toEqual([[FROM, `nope: ${msg}`]]);
      expect(r1(run([pages({ ...pagesProp, from: { field: "state", key: "pages" } })]))).toEqual([[FROM, `state: ${msg}`]]);
      const chained = { op: "add" as const, path: "/objectTypes/Book/properties/pages2", value: { ...pagesProp, from: { field: "pages", key: "pages" } } };
      expect(r1(run([chained]))).toEqual([["objectTypes.Book.properties.pages2.from", `pages: ${msg}`]]);
    });
    it("a field that has from and no type", () => {
      const msg = "field must name a declared property of Book that has neither from nor type";
      const { type: _t, ...untyped } = pagesProp;
      const pages0: Op = { op: "add", path: "/objectTypes/Book/properties/pages0", value: untyped };
      const pages2: Op = { op: "add", path: "/objectTypes/Book/properties/pages2", value: { ...pagesProp, from: { field: "pages0", key: "pages" } } };
      expect(r1(run([pages0, pages2]))).toEqual([
        ["objectTypes.Book.properties.pages0.from", "needs type"],
        ["objectTypes.Book.properties.pages2.from", `pages0: ${msg}`],
      ]);
    });
    it("the name id, the scope field or the state property", () => {
      const named = (n: string) => r1(run([{ op: "add", path: `/objectTypes/Book/properties/${n}`, value: pagesProp }]));
      expect(named("id")).toEqual([["objectTypes.Book.properties.id.from", "id cannot be projected: decide reads it for identity"]]);
      expect(named("branch_id")).toEqual([["objectTypes.Book.properties.branch_id.from", "branch_id cannot be projected: it is the scope field"]]);
      const state = r1(run([{ op: "replace", path: "/objectTypes/Book/properties/state", value: { ...pagesProp, type: "enum" } }]));
      expect(state).toContainEqual(["objectTypes.Book.properties.state.from", "state cannot be projected: it is the state property of Book"]);
      // an object without a state machine may project a property named like the configured state property
      const member = r1(run([
        { op: "add", path: "/objectTypes/Member/properties/meta", value: { class: "canonical", cite: mq } },
        { op: "add", path: "/objectTypes/Member/properties/state", value: { ...pagesProp, type: "enum", from: { field: "meta", key: "state" } } },
      ]));
      expect(member).toEqual([]);
    });
    it("the via of a link type", () => {
      const link = { id: "book_meta", from: "Book", to: "Person", cardinality: "N:1", via: "pages", doc: "L1" };
      expect(r1(run([{ op: "add", path: "/linkTypes/-", value: link }]))).toContainEqual(["linkTypes.book_meta.via", "pages is a projected property: a navigation over the link reads it"]);
    });
    it("edits that name it", () =>
      expect(r1(run([{ op: "add", path: "/actionTypes/BORROW/edits/-", value: "Book.pages" }]))).toEqual([
        ["actionTypes.BORROW", "Book.pages is projected from Book.metadata_json; edit Book.metadata_json"],
      ]));
    it("materializedFrom and canonical_values on a projected property pass", () =>
      expect(triples(run([pages({ ...pagesProp, class: "derived", canonical_values: { values: ["pages"], cite: mq }, materializedFrom: { reads: ["Book.title"], cites: [{ cite: mq }] } })]))).toEqual([]));
  });

  describe("T3 R2", () => {
    it("a projected property that is a field line is projected_property_is_field", () =>
      expect(triples(run([], docWith("- pages")))).toEqual([["R2", "projected_property_is_field", "Book.pages"]]));
    it("a key that is not in the quote is projection_key_not_in_quote", () =>
      expect(triples(run([pages({ ...pagesProp, from: { field: "metadata_json", key: "page" } })]))).toEqual([["R2", "projection_key_not_in_quote", "Book.pages"]]));
    it("projection_key_not_in_quote applies only when the cite has a quote; SPEC and schema say so", () => {
      const r = run([pages({ ...pagesProp, from: { field: "metadata_json", key: "page" }, cite: { doc: "L1" } })]);
      expect(r.violations.filter((x) => x.kind === "projection_key_not_in_quote")).toEqual([]);
      const row = specText.split("\n").find((l) => l.startsWith("| R2 |"))!;
      expect(row).toContain("when its cite has a quote, its key is in that quote (`projection_key_not_in_quote`)");
      expect(schemaText).toContain("when the cite has a quote, `key` occurs as a whole identifier in that quote (`projection_key_not_in_quote`");
    });
  });

  describe("T4 R11 and query", () => {
    const band: Op = { op: "add", path: "/objectTypes/Book/properties/page_band", value: { class: "derived", cite: mq, materializedFrom: { reads: ["Book.pages"], cites: [{ cite: mq }] } } };
    const edit = (e: string): Op => ({ op: "add", path: "/actionTypes/BORROW/edits/-", value: e });
    const r11 = (r: ReturnType<typeof check>) => r.violations.filter((x) => x.rule === "R11").map((x) => [x.key, x.msg]);
    it("an edit of the field writes the projected input of a materialized property", () => {
      expect(r11(run([band, edit("Book.metadata_json")], docWith("- page_band")))).toEqual([
        ["BORROW:Book.page_band", "BORROW writes Book.pages (inputs of Book.page_band) but does not list Book.page_band in edits"],
      ]);
      expect(r11(run([band, edit("Book.metadata_json"), edit("Book.page_band")], docWith("- page_band")))).toEqual([]);
    });
    it("a materialized projected property is listed by an edit of its field", () => {
      const mat = pages({ ...pagesProp, class: "derived", materializedFrom: { reads: ["Book.title"], cites: [{ cite: mq }] } });
      expect(r11(run([mat, edit("Book.title")]))).toEqual([["BORROW:Book.pages", "BORROW writes Book.title (inputs of Book.pages) but does not list Book.metadata_json in edits"]]);
      expect(r11(run([mat, edit("Book.title"), edit("Book.metadata_json")]))).toEqual([]);
    });

    const longBook = { of: "Book", type: "boolean", expr: { gt: [{ ref: "self.pages" }, { ref: "self.pages" }] }, cite: mq };
    const q = () => applyPatch(ont, [...base, band, edit("Book.metadata_json"), { op: "add", path: "/derivedProperties/long_book", value: longBook },
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "pages_probe", expr: { isNotNull: [{ ref: "book_id.pages" }] }, cites: [{ cite: mq }] } }]);
    it("query writes: the writers of the field, through the projected property", () => {
      expect(queryWrites(q(), "Book.pages")!.writers).toEqual([{ action: "BORROW", cite: null, path: ["Book.metadata_json"] }]);
      expect(queryWrites(q(), "Book.long_book")!.writers).toEqual([{ action: "BORROW", cite: null, path: ["Book.pages", "Book.metadata_json"] }]);
      expect(queryWrites(q(), "Book.metadata_json")!.writers).toEqual([{ action: "BORROW", cite: null, path: [] }]);
    });
    it("query reads of the field lists the readers of the projected property", () => {
      const r = queryReads(q(), "Book.metadata_json")!;
      expect(r.conditions).toEqual([{ action: "BORROW", condition: "pages_probe", source: "expr", direct: true, via: [], rows: [] }]);
      expect(r.derived).toEqual([{ id: "long_book", source: "expr", direct: true, via: [] }]);
      expect(r.materialized).toEqual(["Book.page_band"]);
    });
    it("query reads of the field reaches a condition through a derived chain", () => {
      const d = (id: string, expr: unknown): Op => ({ op: "add", path: `/derivedProperties/${id}`, value: { of: "Book", type: "boolean", expr, cite: mq } });
      const o = applyPatch(ont, [...base,
        d("d2", { isNotNull: [{ ref: "self.pages" }] }),
        d("d1", { not: [{ derived: { id: "d2", of: { ref: "self" } } }] }),
        { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "chain_probe", expr: { derived: { id: "d1", of: { ref: "book_id" } } }, cites: [{ cite: mq }] } }]);
      const r = queryReads(o, "Book.metadata_json")!;
      expect(r.conditions).toEqual([{ action: "BORROW", condition: "chain_probe", source: "expr", direct: false, via: ["d1"], rows: [] }]);
      expect(r.derived).toEqual([{ id: "d1", source: "expr", direct: false, via: ["d2"] }, { id: "d2", source: "expr", direct: true, via: [] }]);
    });
    it("query writes of a derived property that reads two keys of one column: one writer entry per action", () => {
      const two = { of: "Book", type: "boolean", expr: { gt: [{ ref: "self.pages" }, { ref: "self.pages2" }] }, cite: mq };
      const o = applyPatch(ont, [...base, edit("Book.metadata_json"),
        { op: "add", path: "/objectTypes/Book/properties/pages2", value: { ...pagesProp, from: { field: "metadata_json", key: "pages2" } } },
        { op: "add", path: "/derivedProperties/two_keys", value: two }]);
      expect(queryWrites(o, "Book.two_keys")!.writers).toEqual([{ action: "BORROW", cite: null, path: ["Book.pages", "Book.metadata_json"] }]);
    });
    it("T8 query object gives from", () => {
      const props = queryObject(q(), "Book")!.properties;
      expect(props.find((p) => p.name === "pages")!.from).toEqual({ field: "metadata_json", key: "pages" });
      expect(props.find((p) => p.name === "title")!.from).toBeNull();
    });
  });

  describe("T5 projectSnapshot", () => {
    const thing = (key = "n"): Stage1Ontology => ({
      objectTypes: { Thing: { datasource: "things", properties: { meta: {}, n: { type: "integer", from: { field: "meta", key } } } } },
      linkTypes: [],
      actionTypes: {},
    });
    const throws = vi.fn<Decode>(() => {
      throw new Error("decode is not called for a projected value");
    });
    const one = (row: Record<string, unknown>, ont = thing()) => {
      const out = projectSnapshot(ont, { things: [{ id: "t1", ...row }] }, throws);
      return { row: out.snapshot.objects.Thing![0], defects: out.defects };
    };
    const defect = (value: unknown) => [{ object: "Thing", prop: "n", row: "t1", value }];
    it("projects the key of a JSON string or object; a stored column n is replaced", () => {
      expect(one({ meta: '{"n":3}', n: 9 })).toStrictEqual({ row: { id: "t1", meta: '{"n":3}', n: 3 }, defects: [] });
      expect(one({ meta: { n: 3 } })).toStrictEqual({ row: { id: "t1", meta: { n: 3 }, n: 3 }, defects: [] });
      expect(throws).not.toHaveBeenCalled();
    });
    it("null when the column is null, the key is absent or null; constructor is not an own key", () => {
      expect(one({ meta: null, n: 9 }).row).toStrictEqual({ id: "t1", meta: null, n: null });
      expect(one({ meta: "{}" })).toStrictEqual({ row: { id: "t1", meta: "{}", n: null }, defects: [] });
      expect(one({ meta: '{"n":null}' }).row).toStrictEqual({ id: "t1", meta: '{"n":null}', n: null });
      expect(one({ meta: "{}" }, thing("constructor"))).toStrictEqual({ row: { id: "t1", meta: "{}", n: null }, defects: [] });
    });
    it("an own key whose value is undefined is an absent key: n is null", () =>
      expect(one({ meta: { n: undefined } })).toStrictEqual({ row: { id: "t1", meta: { n: undefined }, n: null }, defects: [] }));
    it("a declared field named toString with no such column is not projected", () => {
      const o: Stage1Ontology = {
        objectTypes: { Thing: { datasource: "things", properties: { toString: {}, n: { type: "integer", from: { field: "toString", key: "n" } } } } },
        linkTypes: [],
        actionTypes: {},
      };
      expect(one({ n: 9 }, o)).toStrictEqual({ row: { id: "t1" }, defects: [] });
    });
    it("a Buffer, a Date, a Map or a Uint8Array is a defect, and n is not set; a null-prototype object projects", () => {
      for (const meta of [Buffer.from('{"n":3}'), new Date(0), new Map([["n", 3]]), new Uint8Array([3])])
        expect(one({ meta, n: 9 }), String(meta)).toStrictEqual({ row: { id: "t1", meta }, defects: defect(meta) });
      const bare = Object.assign(Object.create(null), { n: 3 });
      expect(one({ meta: bare })).toStrictEqual({ row: { id: "t1", meta: bare, n: 3 }, defects: [] });
    });
    it("an absent column is not projected: a stored column n is deleted", () => {
      expect(one({ n: 9 })).toStrictEqual({ row: { id: "t1" }, defects: [] });
      expect(one({ meta: undefined, n: 9 })).toStrictEqual({ row: { id: "t1", meta: undefined }, defects: [] });
    });
    it("a parse error, an array or a value that does not fit is a defect, and n is deleted", () => {
      expect(one({ meta: "{nope", n: 9 })).toStrictEqual({ row: { id: "t1", meta: "{nope" }, defects: defect("{nope") });
      expect(one({ meta: "[3]", n: 9 })).toStrictEqual({ row: { id: "t1", meta: "[3]" }, defects: defect("[3]") });
      expect(one({ meta: 3 })).toStrictEqual({ row: { id: "t1", meta: 3 }, defects: defect(3) });
      expect(one({ meta: '{"n":"3"}', n: 9 })).toStrictEqual({ row: { id: "t1", meta: '{"n":"3"}' }, defects: defect("3") });
      expect(one({ meta: '{"n":1.5}' })).toStrictEqual({ row: { id: "t1", meta: '{"n":1.5}' }, defects: defect(1.5) });
      expect(throws).not.toHaveBeenCalled();
    });
  });

  it("T6 a projected read may be null even when a non-null field line exists (waived)", () => {
    const waiver = { id: "G1", rule: "R2", kind: "projected_property_is_field", keys: ["Book.pages"], doc_line: "- pages", conflict: "probe", proposed: "probe" };
    const probe: Op[] = [
      { op: "add", path: "/actionTypes/BORROW/conditions/-", value: { id: "pages_probe", expr: { eq: [{ ref: "book_id.pages" }, { ref: "book_id.pages" }] }, cites: [{ cite: mq }] } },
      { op: "add", path: "/actionTypes/BORROW/decision/rows/-", value: { when: { passes: "pages_probe" }, result: "BORROWED", cites: [{ cite: { doc: "L6", quote: "Otherwise BORROW is BORROWED." } }] } },
    ];
    const r = run([{ op: "replace", path: "/knownSourceGaps", value: [waiver] }, ...probe], docWith("- pages"));
    expect(triples(r)).toEqual([["R12", "unsafe_fallthrough", "BORROW:rows.4"]]);
    expect(r.waived.map((x) => x.kind)).toEqual(["projected_property_is_field"]);
    // control: the same read of a plain non-null column is two-valued
    const { from: _f, ...plain } = pagesProp;
    expect(triples(run([pages(plain), ...probe], docWith("- pages")))).toEqual([]);
  });

  describe("T7 decide over a projected property", () => {
    const o: Stage1Ontology = {
      dispositions: { ACCEPTED: { class: "applied" }, REJECTED: { class: "rejected" } },
      objectTypes: {
        Upload: { datasource: "uploads", properties: { declared_size: { type: "integer" } } },
        Proof: { datasource: "proofs", properties: { metadata_json: {}, size_bytes: { type: "integer", from: { field: "metadata_json", key: "size_bytes" } } } },
      },
      linkTypes: [],
      actionTypes: {
        CHECK: {
          parameters: { x: { type: { ref: "Upload" } }, y: { type: { ref: "Proof" } } },
          permission: { none: "anyone" },
          conditions: [{ id: "sizes_match", expr: { eq: [{ ref: "x.declared_size" }, { ref: "y.size_bytes" }] } as Expr }],
          decision: { rows: [{ when: { fails: "sizes_match" }, result: "REJECTED" }], otherwise: { result: "ACCEPTED" } },
        },
      } as unknown as Stage1Ontology["actionTypes"],
    };
    const identity: Decode = (raw) => raw as never;
    const snap = (meta: unknown): Snapshot => projectSnapshot(o, { uploads: [{ id: "u1", declared_size: 10 }], proofs: [{ id: "p1", metadata_json: meta }] }, identity).snapshot;
    const actor = { id: "a", keys: [], kind: "Person" };
    const env = (meta: unknown) => ({ action: "CHECK", snapshot: snap(meta), scope: null, bindings: { x: "u1", y: "p1" }, actor, now: 0 });
    const cond = o.actionTypes.CHECK!.conditions[0]!.expr!;
    it("T, F and U (key absent)", () => {
      expect(evalPredicate(o, cond, env('{"size_bytes":10}'))).toBe("T");
      expect(evalPredicate(o, cond, env('{"size_bytes":11}'))).toBe("F");
      expect(evalPredicate(o, cond, env("{}"))).toBe("U");
      const result = (meta: unknown) => decide(o, "CHECK", snap(meta), null, { x: "u1", y: "p1" }, actor, 0);
      expect(result('{"size_bytes":10}')).toMatchObject({ layer: "domain", result: "ACCEPTED" });
      expect(result("{}")).toMatchObject({ layer: "domain", result: "REJECTED", row: 0 });
    });
  });
});
