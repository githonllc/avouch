// The package root ("." in package.json exports) is the only import path a consumer has; deep paths are blocked.
import { describe, expect, it } from "vitest";
import * as root from "../src/index";

describe("package root exports", () => {
  it("exposes the static UNKNOWN analysis", () => {
    for (const name of ["mayUnknown", "mayNullIn", "absorbingQuantifiers", "freeNullableRefs", "abstractEval"]) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
    expect((root as Record<string, unknown>).MAX_NULLABLE_REFS).toBe(8);
  });
});
