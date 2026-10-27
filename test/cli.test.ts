import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const result = run("check", "-f", ontology, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toMatch(/^PASS/);
  });

  it("reports a checker violation", () => {
    const mutation = parse(readFileSync(join(root, "examples/library/mutations/lib-r8-unknown-event.yaml"), "utf8"));
    const path = temporaryFile("ontology.yaml", stringify(applyPatch(clean(), mutation.patch)));
    const result = run("check", "-f", path, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL R8 ");
  });

  it("reports a schema error", () => {
    const path = temporaryFile("ontology.yaml", stringify({ ...clean(), bogusKey: 1 }));
    const result = run("check", "-f", path, "--adapter", adapter);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("SCHEMA /");
  });

  it("requires the adapter argument", () => {
    const result = run("check", "-f", ontology);
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
      const result = run("check", "-f", withConfig({ ...fixture, docs: [library] }));
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
    });

    it("without --adapter and without avouch.json: exit 2 and a reason", () => {
      const result = run("check", "-f", temporaryFile("ontology.yaml", waived()));
      expect(result.status).toBe(2);
      expect(result.stderr.split("\n")[0]).toMatch(/^no adapter: no avouch\.json next to /);
      expect(result.stderr).toContain("usage: avouch check");
    });

    it("a document that cannot be read: exit 2", () => {
      const result = run("check", "-f", withConfig({ ...fixture, docs: ["no-such-file.md"] }));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("docs[0]:");
    });

    it("two docs entries that resolve to one file: exit 2", () => {
      const path = withConfig((directory: string) => ({ ...fixture, docs: [library, relative(directory, library)] }));
      const result = run("check", "-f", path);
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
        const result = run("check", "-f", twoNames([...names], link));
        expect(result.status, names.join()).toBe(2);
        expect(result.stderr).toContain("docs[1]: duplicate of docs[0]");
      }
    });

    it("docs entries that differ only in case on a case-insensitive file system: exit 2", (ctx) => {
      const path = twoNames(["a.md", "A.md"]);
      if (!existsSync(join(dirname(path), "A.md"))) ctx.skip();
      const result = run("check", "-f", path);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("docs[1]: duplicate of docs[0]");
    });

    it("an unknown configuration key: exit 2", () => {
      const result = run("check", "-f", withConfig({ ...fixture, docs: [library], extra: true }));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("extra: unknown key");
    });

    it("--adapter <config.json> on the clean toy: the evidence ids fail R1 and the missing evidence fails R6", () => {
      const result = run("check", "-f", ontology, "--adapter", markdown);
      expect(result.status, result.stderr).toBe(1);
      const fails = result.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(0, l.indexOf(": ") + 1)).sort();
      expect(fails).toEqual(["FAIL R1 generic actionTypes.BORROW:", "FAIL R1 generic actionTypes.RETURN:", "FAIL R6 fact_missing facts.evidence:"]);
      expect(result.stdout.trim().split("\n").at(-1)).toBe("FAIL: 0 schema error(s), 3 violation(s), 0 waived");
    });

    describe("default ontology file", () => {
      const cli = join(root, "dist/cli/avouch.js");
      const runIn = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
      const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
      const gitAvailable = git(root, "--version").status === 0;
      const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1);
      // a git repository with avouch/avouch.ontology.yaml and avouch/avouch.json (the clean toy, waived), and a subdirectory
      const repository = () => {
        const top = mkdtempSync(join(tmpdir(), "avouch-cli-"));
        directories.push(top);
        expect(git(top, "init", "-q").status).toBe(0);
        mkdirSync(join(top, "avouch"));
        mkdirSync(join(top, "src/deep"), { recursive: true });
        writeFileSync(join(top, "avouch/avouch.ontology.yaml"), waived());
        writeFileSync(join(top, "avouch/avouch.json"), JSON.stringify({ ...fixture, docs: [library] }));
        return top;
      };

      it.skipIf(!gitAvailable)("check without -f uses the file of the git top level, from a subdirectory", () => {
        const top = repository();
        const sub = join(top, "src/deep");
        const withF = runIn(sub, "check", "-f", join(top, "avouch/avouch.ontology.yaml"));
        const byDefault = runIn(sub, "check");
        expect(withF.status, withF.stdout + withF.stderr).toBe(0);
        expect(byDefault.status, byDefault.stdout + byDefault.stderr).toBe(0);
        expect(byDefault.stdout).toBe(withF.stdout);
        expect(lastLine(byDefault.stdout)).toBe("PASS: 0 schema error(s), 0 violation(s), 1 waived");
      });

      it.skipIf(!gitAvailable)("query list actions without -f uses the same file, from a subdirectory", () => {
        const top = repository();
        const sub = join(top, "src/deep");
        const withF = runIn(sub, "query", "list", "actions", "-f", join(top, "avouch/avouch.ontology.yaml"));
        const byDefault = runIn(sub, "query", "list", "actions");
        expect(withF.status, withF.stderr).toBe(0);
        expect(byDefault.status, byDefault.stderr).toBe(0);
        expect(byDefault.stdout).toBe(withF.stdout);
      });

      it.skipIf(!gitAvailable)("the three stamp lines of query text output are stable, with -f and with the default", () => {
        const sub = join(repository(), "src/deep");
        const withF = runIn(root, "query", "list", "actions", "-f", ontology);
        const byDefault = runIn(sub, "query", "list", "actions");
        for (const r of [withF, byDefault]) {
          expect(r.status, r.stderr).toBe(0);
          const lines = r.stdout.split("\n");
          expect(lines[0]).toMatch(/^ontology: /);
          expect(lines[1]).toMatch(/^commit: ([0-9a-f]{40}( \(dirty\))?|none \(not in git\))$/);
          expect(lines[2]).toMatch(/^check: /);
        }
      });

      it.skipIf(!gitAvailable)("the default file missing: exit 2 and the path", () => {
        const top = mkdtempSync(join(tmpdir(), "avouch-cli-"));
        directories.push(top);
        expect(git(top, "init", "-q").status).toBe(0);
        const real = realpathSync(top);
        for (const args of [["check"], ["query", "list", "actions"], ["reconcile", "--cases", "x.jsonl"], ["gate", "verify", "--rows", "x.jsonl"]]) {
          const r = runIn(top, ...args);
          expect(r.status, args.join(" ")).toBe(2);
          expect(r.stderr, args.join(" ")).toContain(join(real, "avouch/avouch.ontology.yaml"));
          expect(r.stderr, args.join(" ")).toContain("does not exist");
        }
      });

      it("not in a git repository: exit 2 and a reason", (ctx) => {
        const directory = mkdtempSync(join(tmpdir(), "avouch-cli-"));
        directories.push(directory);
        if (!gitAvailable || git(directory, "rev-parse", "--show-toplevel").status === 0) ctx.skip();
        for (const args of [["check"], ["query", "list", "actions"], ["reconcile", "--cases", "x.jsonl"], ["gate", "verify", "--rows", "x.jsonl"]]) {
          const r = runIn(directory, ...args);
          expect(r.status, args.join(" ")).toBe(2);
          expect(r.stderr, args.join(" ")).toContain("not in a git repository");
        }
      });
    });
  });

  it("requires a named facts export", () => {
    const path = temporaryFile("adapter.mjs", "export const other = () => ({});\n");
    const result = run("check", "-f", ontology, "--adapter", path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("facts");
  });

  it("the old positional form gives exit 2 and points to -f", () => {
    for (const args of [["check", "x.ontology.yaml"], ["check", "x.yml", "--adapter", adapter], ["query", "action", "BORROW", "x.ontology.yaml"], ["reconcile", "x.ontology.yaml", "--cases", "c.jsonl"], ["gate", "verify", "x.ontology.yaml", "--rows", "r.jsonl"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("unexpected argument x.");
      expect(r.stderr, args.join(" ")).toContain("give the ontology with -f");
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });

  it("-f without a value, -f twice and an unknown -z give exit 2", () => {
    for (const args of [["check", "-f"], ["check", "-f", ontology, "-f", ontology], ["check", "-f", ontology, "-z"], ["check", "-z"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("usage: avouch check");
    }
  });
});
