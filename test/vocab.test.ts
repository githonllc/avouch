// vocab.ttl (the RDF vocabulary) must change together with ontology.schema.json:
// every schema field needs a vocab term, unless an explicit rule below excludes it.
import { describe, expect, it } from "vitest";
import schemaText from "../ontology.schema.json?raw";
import ttlText from "../vocab.ttl?raw";

type Field = { name: string; pointer: string };
const SUBSCHEMA_MAPS = ["$defs", "patternProperties"] as const;
const SUBSCHEMA_LISTS = ["oneOf", "anyOf", "allOf"] as const;
const SUBSCHEMAS = ["items", "additionalProperties", "then", "else", "if", "not"] as const;

// Walk a JSON Schema. A field name is a key of a `properties` keyword object; all other keys are keywords.
export function schemaFields(node: unknown, pointer = ""): Field[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [];
  const s = node as Record<string, unknown>;
  const out: Field[] = [];
  const props = s.properties;
  if (props && typeof props === "object") {
    for (const [name, sub] of Object.entries(props)) {
      const p = `${pointer}/properties/${name}`;
      out.push({ name, pointer: p }, ...schemaFields(sub, p));
    }
  }
  for (const k of SUBSCHEMA_MAPS) {
    const m = s[k];
    if (m && typeof m === "object") for (const [n, sub] of Object.entries(m)) out.push(...schemaFields(sub, `${pointer}/${k}/${n}`));
  }
  for (const k of SUBSCHEMA_LISTS) {
    const l = s[k];
    if (Array.isArray(l)) l.forEach((sub, i) => out.push(...schemaFields(sub, `${pointer}/${k}/${i}`)));
  }
  for (const k of SUBSCHEMAS) out.push(...schemaFields(s[k], `${pointer}/${k}`));
  return out;
}

// Exclusion rules: each field excluded by exactly one rule, with its reason.
export const RULES: { id: string; reason: string; match: (pointer: string) => boolean }[] = [
  {
    id: "root-section",
    reason: "top-level sections (objectTypes, actionTypes, contexts, formatVersion ...) are exported as classes or resources, not predicates",
    match: (p) => p.split("/").length === 3 && p.startsWith("/properties/"),
  },
  {
    id: "expr",
    reason: "an expression is exported as one rdf:JSON literal, not as triples",
    match: (p) => p.startsWith("/$defs/expr/"),
  },
  {
    id: "objectType.properties",
    reason: "the `properties` field of objectType is exported as owl:DatatypeProperty",
    match: (p) => p === "/$defs/objectType/properties/properties",
  },
  {
    id: "valueType.ref",
    reason: "a value type {ref: X} is exported as the class X itself, the object of ofv:type; only the field `ref` is excluded",
    match: (p) => p.startsWith("/$defs/valueType/") && p.endsWith("/properties/ref"),
  },
];

export const vocabTerms = (ttl: string) => new Set([...ttl.matchAll(/^ofv:([A-Za-z_]+) a /gm)].map((m) => m[1]));

export function missingFields(schemaJson: string, ttl: string) {
  const terms = vocabTerms(ttl);
  const fields = schemaFields(JSON.parse(schemaJson));
  const excluded: Record<string, number> = {};
  const missing: Field[] = [];
  for (const f of fields) {
    const rule = RULES.find((r) => r.match(f.pointer));
    if (rule) excluded[rule.id] = (excluded[rule.id] ?? 0) + 1;
    else if (!terms.has(f.name)) missing.push(f);
  }
  return { fields, excluded, missing };
}

describe("vocab.ttl", () => {
  it("every schema field has a vocab term", () => {
    const { fields, excluded, missing } = missingFields(schemaText, ttlText);
    console.log(`fields=${fields.length} excluded=${JSON.stringify(excluded)} terms=${vocabTerms(ttlText).size}`);
    const msg = missing.map((m) => `  ${m.name} at ${m.pointer}`).join("\n");
    expect(missing, `schema fields without a vocab term:\n${msg}\nadd a term to vocab.ttl or an exclusion rule with its reason`).toEqual([]);
  });

  it("detects a missing term (mutation: ofv:deletes removed)", () => {
    const mutated = ttlText.replace(/^ofv:deletes a [\s\S]*? \.$\n?/m, "");
    expect(mutated).not.toBe(ttlText);
    expect(missingFields(schemaText, mutated).missing.map((m) => m.name)).toContain("deletes");
  });

  it("vocab terms are well formed", () => {
    const blocks = [...ttlText.matchAll(/^(ofv:[A-Za-z_]+) [\s\S]*? \.$/gm)];
    expect(blocks.length).toBeGreaterThan(0);
    const bad = blocks
      .filter(([b]) => !/rdfs:label /.test(b) || !/rdfs:comment /.test(b) || !b.includes("rdfs:isDefinedBy <https://w3id.org/avouch/v1/vocab>"))
      .map(([, s]) => s);
    expect(bad, "terms missing rdfs:label, rdfs:comment or rdfs:isDefinedBy").toEqual([]);
  });

  it("vocab namespace", () => {
    expect(ttlText).toContain("@prefix ofv: <https://w3id.org/avouch/v1/vocab#> .");
  });
});
