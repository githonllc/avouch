// Compile-time API check: a consumer Decode narrows `Type` to `Scalar | { set: Scalar }`. `npm run typecheck` covers this
// file; a wider `Type` (records belong to `ParameterType`) breaks it.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Decode, ParameterType, RecordType, Scalar, Type } from "../src/index";

const decodeElement = (raw: unknown, type: Scalar): unknown => (type === "integer" ? Number(raw) : raw);

const decode: Decode = (raw, type) => {
  if (typeof type === "string" || !("set" in type)) return decodeElement(raw, type) as never;
  const element: Scalar = type.set;
  return (Array.isArray(raw) ? raw.map((x) => decodeElement(x, element)) : undefined) as never;
};

describe("Type and ParameterType", () => {
  it("keeps Type to property values and puts records in ParameterType", () => {
    expectTypeOf<Type>().toEqualTypeOf<Scalar | { set: Scalar }>();
    expectTypeOf<ParameterType>().toEqualTypeOf<Type | RecordType | { set: RecordType }>();
    expectTypeOf<Parameters<Decode>[1]>().toEqualTypeOf<Type>();
    expect(decode("3", "integer")).toBe(3);
    expect(decode(["1", "2"], { set: "integer" })).toEqual([1, 2]);
  });
});
