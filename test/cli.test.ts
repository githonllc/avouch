import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { applyPatch } from "../src/patch";

const root = fileURLToPath(new URL("../", import.meta.url));
const ontology = "examples/library/library.ontology.yaml";
const adapter = "test/fixtures/library-adapter.mjs";
const directories: string[] = [];
const run = (...args: string[]) => spawnSync(process.execPath, ["dist/cli/avouch.js", ...args], { cwd: root, encoding: "utf8" });
const temporaryFile = (name: string, text: string) => {
  const directory = mkdtempSync(join(tmpdir(), "avouch-cli-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
};
const clean = () => parse(readFileSync(join(root, ontology), "utf8"));

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("command line", () => {
  it("accepts the clean toy ontology", () => {
    const result = run("check", ontology, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toMatch(/^PASS/);
  });

  it("reports a checker violation", () => {
    const mutation = parse(readFileSync(join(root, "examples/library/mutations/lib-r8-unknown-event.yaml"), "utf8"));
    const path = temporaryFile("ontology.yaml", stringify(applyPatch(clean(), mutation.patch)));
    const result = run("check", path, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL R8 ");
  });

  it("reports a schema error", () => {
    const path = temporaryFile("ontology.yaml", stringify({ ...clean(), bogusKey: 1 }));
    const result = run("check", path, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("SCHEMA /");
  });

  it("requires the adapter argument", () => {
    const result = run("check", ontology);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: avouch check");
  });

  describe("built-in Markdown adapter", () => {
    const markdown = "test/fixtures/library-markdown.json";
    const library = join(root, "examples/library/library.md");
    const fixture = JSON.parse(readFileSync(join(root, markdown), "utf8"));
    // the clean toy ontology without evidence ids, with a waiver for the evidence that the Markdown adapter does not read
    const waived = () => {
      const o = clean();
      for (const a of Object.values(o.actionTypes as Record<string, Record<string, unknown>>)) delete a.evidence;
      o.knownSourceGaps = [{ id: "NO-EVIDENCE", rule: "R6", kind: "fact_missing", keys: ["facts.evidence"], doc_line: "test", conflict: "test", proposed: "test" }];
      return stringify(o);
    };
    const withConfig = (config: unknown | ((directory: string) => unknown)) => {
      const path = temporaryFile("ontology.yaml", waived());
      const c = typeof config === "function" ? config(dirname(path)) : config;
      writeFileSync(join(dirname(path), "avouch.json"), JSON.stringify(c));
      return path;
    };

    it("reads the avouch.json next to the ontology when no adapter is given", () => {
      const result = run("check", withConfig({ ...fixture, docs: [library] }));
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
    });

    it("without --adapter and without avouch.json: exit 2 and a reason", () => {
      const result = run("check", temporaryFile("ontology.yaml", waived()));
      expect(result.status).toBe(2);
      expect(result.stderr.split("\n")[0]).toMatch(/^no adapter: no avouch\.json next to /);
      expect(result.stderr).toContain("usage: avouch check");
    });

    it("a document that cannot be read: exit 2", () => {
      const result = run("check", withConfig({ ...fixture, docs: ["no-such-file.md"] }));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("docs[0]:");
    });

    it("two docs entries that resolve to one file: exit 2", () => {
      const path = withConfig((directory: string) => ({ ...fixture, docs: [library, relative(directory, library)] }));
      const result = run("check", path);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("docs[1]: duplicate of docs[0]");
    });

    // a.md in the configuration directory, named by the given docs entries
    const twoNames = (names: string[], link = false) =>
      withConfig((directory: string) => {
        writeFileSync(join(directory, "a.md"), readFileSync(library, "utf8"));
        if (link) symlinkSync(join(directory, "a.md"), join(directory, "b.md"));
        return { ...fixture, docs: names };
      });

    it("docs entries that name one file by different paths: exit 2", () => {
      for (const [names, link] of [[["a.md", "./sub/../a.md"], false], [["a.md", "b.md"], true]] as const) {
        const result = run("check", twoNames([...names], link));
        expect(result.status, names.join()).toBe(2);
        expect(result.stderr).toContain("docs[1]: duplicate of docs[0]");
      }
    });

    it("docs entries that differ only in case on a case-insensitive file system: exit 2", (ctx) => {
      const path = twoNames(["a.md", "A.md"]);
      if (!existsSync(join(dirname(path), "A.md"))) ctx.skip();
      const result = run("check", path);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("docs[1]: duplicate of docs[0]");
    });

    it("an unknown configuration key: exit 2", () => {
      const result = run("check", withConfig({ ...fixture, docs: [library], extra: true }));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("extra: unknown key");
    });

    it("--adapter <config.json> on the clean toy: the evidence ids fail R1 and the missing evidence fails R6", () => {
      const result = run("check", ontology, "--adapter", markdown);
      expect(result.status, result.stderr).toBe(1);
      const fails = result.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(0, l.indexOf(": ") + 1)).sort();
      expect(fails).toEqual(["FAIL R1 generic actionTypes.BORROW:", "FAIL R1 generic actionTypes.RETURN:", "FAIL R6 fact_missing facts.evidence:"]);
      expect(result.stdout.trim().split("\n").at(-1)).toBe("FAIL: 0 schema error(s), 3 violation(s), 0 waived");
    });
  });

  it("requires a named facts export", () => {
    const path = temporaryFile("adapter.mjs", "export const other = () => ({});\n");
    const result = run("check", ontology, "--adapter", path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("facts");
  });
});
