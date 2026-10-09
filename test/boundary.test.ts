// Import boundary of the runtime (src/ and examples/): every import resolves inside this package; no npm package, no outside file.
// Test files (test/) and vitest.config.ts may import npm packages; they are not runtime.
import ts from "typescript";
import { describe, expect, it } from "vitest";

const files = import.meta.glob(["../src/**/*.ts", "../examples/**/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// file: a glob key such as "../src/checker.ts" (relative to test/). An import resolves inside when it is relative, never leaves the package root
// and never enters node_modules. Empty segments ("a//b") count as nothing, as in a file system path.
function resolvesInside(file: string, spec: string): boolean {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
  const parts = file.split("/").slice(1, -1);
  for (const seg of spec.split("/")) {
    if (seg === "node_modules") return false;
    if (seg === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return true;
}
const outside = (all: Record<string, string>) =>
  Object.entries(all).flatMap(([file, text]) =>
    ts.preProcessFile(text, true, true).importedFiles.filter((i) => !resolvesInside(file, i.fileName)).map((i) => `${file}: ${i.fileName}`),
  );

describe("runtime import boundary", () => {
  it("checks src/ and examples/", () => {
    expect(Object.keys(files).some((f) => f.startsWith("../src/"))).toBe(true);
    expect(Object.keys(files).some((f) => f.startsWith("../examples/"))).toBe(true);
  });

  it("every import resolves inside the package", () => expect(outside(files)).toEqual([]));

  it("self-test: the check rejects an outside file and an npm package, and accepts an inside file", () => {
    const bad = { "../src/x.ts": 'import x from "../../outside/file"; export * from "yaml"; import { y } from "./contract";' };
    expect(outside(bad)).toEqual(["../src/x.ts: ../../outside/file", "../src/x.ts: yaml"]);
    const deep = { "../examples/library/x.ts": 'import a from "../../src/checker"; import b from "../../../outside";' };
    expect(outside(deep)).toEqual(["../examples/library/x.ts: ../../../outside"]);
    const tricky = { "../src/x.ts": 'import a from "..//../tests/x"; import b from "../node_modules/yaml/dist/index.js";' };
    expect(outside(tricky)).toEqual(["../src/x.ts: ..//../tests/x", "../src/x.ts: ../node_modules/yaml/dist/index.js"]);
  });
});

describe("the Markdown adapter is optional", () => {
  it("no src/ file other than index.ts and markdown.ts imports it", () => {
    const importers = Object.entries(files)
      .filter(([file]) => file.startsWith("../src/") && !["../src/index.ts", "../src/markdown.ts"].includes(file))
      .filter(([, text]) => ts.preProcessFile(text, true, true).importedFiles.some((i) => /(^|\/)markdown(\.js|\.ts)?$/.test(i.fileName)))
      .map(([file]) => file);
    expect(importers).toEqual([]);
  });
});

const cli = import.meta.glob("../cli/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const cliOutside = (all: Record<string, string>) =>
  Object.entries(all).flatMap(([file, text]) =>
    ts.preProcessFile(text, true, true).importedFiles
      .filter(({ fileName }) => !resolvesInside(file, fileName) && !fileName.startsWith("node:") && !["yaml", "ajv/dist/2020.js"].includes(fileName))
      .map(({ fileName }) => `${file}: ${fileName}`),
  );

describe("command line import boundary", () => {
  it("checks the command line sources", () => expect(Object.keys(cli).length).toBeGreaterThan(0));
  it("imports only package files and allowed dependencies", () => expect(cliOutside(cli)).toEqual([]));
  it("self-test: rejects another npm package", () => {
    expect(cliOutside({ "../cli/x.ts": 'import x from "lodash";' })).toEqual(["../cli/x.ts: lodash"]);
  });
});
