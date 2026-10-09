import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { applyPatch, type Op } from "../src/patch";

const root = fileURLToPath(new URL("../", import.meta.url));
const ontology = "examples/library/library.ontology.yaml";
const adapter = "test/fixtures/library-adapter.mjs";
const directories: string[] = [];
const run = (...args: string[]) => spawnSync(process.execPath, ["dist/cli/avouch.js", "query", ...args], { cwd: root, encoding: "utf8" });
const json = (...args: string[]) => {
  const r = run(...args, "--json");
  return { ...r, envelope: r.stdout ? JSON.parse(r.stdout) : null };
};
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "avouch-query-"));
  directories.push(directory);
  return directory;
};
const copyOntology = () => {
  const directory = temporaryDirectory();
  const path = join(directory, "library.ontology.yaml");
  copyFileSync(join(root, ontology), path);
  return { directory, path };
};
const patchedOntology = (ops: Op[]) => {
  const path = join(temporaryDirectory(), "library.ontology.yaml");
  writeFileSync(path, stringify(applyPatch(parse(readFileSync(join(root, ontology), "utf8")), ops)));
  return path;
};
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const gitAvailable = git(root, "--version").status === 0;
// Every file outside .git, with its modification time, and the modification time of .git/index.
const snapshot = (directory: string): string[] => {
  const index = join(directory, ".git", "index");
  return [...files(directory), ...(existsSync(index) ? [`.git/index ${statSync(index).mtimeMs}`] : [])];
};
const files = (directory: string, prefix = ""): string[] =>
  readdirSync(join(directory, prefix), { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .flatMap((e) => {
      const rel = join(prefix, e.name);
      return e.isDirectory() ? [rel, ...files(directory, rel)] : [`${rel} ${statSync(join(directory, rel)).mtimeMs}`];
    })
    .sort();

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("avouch query", () => {
  it("prints a versioned envelope with check not_run", () => {
    const r = json("action", "BORROW", ontology);
    expect(r.status, r.stderr).toBe(0);
    expect(r.envelope.avouchQuery).toBe(1);
    expect(r.envelope.stamp.check).toEqual({ status: "not_run" });
    expect(r.envelope.verb).toBe("action");
    expect(r.envelope.arg).toBe("BORROW");
    expect(r.envelope.result.id).toBe("BORROW");
  });

  it("stamps no git outside a repository", () => {
    const { path } = copyOntology();
    const r = json("action", "BORROW", path);
    expect(r.status, r.stderr).toBe(0);
    expect(r.envelope.stamp.git).toBeNull();
    const text = run("action", "BORROW", path);
    expect(text.stdout.split("\n")[1]).toBe("commit: none (not in git)");
  });

  it.skipIf(!gitAvailable)("stamps the commit, the dirty flag and the repository path", () => {
    const { directory, path } = copyOntology();
    expect(git(directory, "init", "-q").status).toBe(0);
    expect(git(directory, "add", "library.ontology.yaml").status).toBe(0);
    const c = git(directory, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x");
    expect(c.status, c.stderr).toBe(0);
    const clean = json("object", "Loan", path);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.envelope.stamp.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.envelope.stamp.git.dirty).toBe(false);
    expect(clean.envelope.stamp.git.path).toBe("library.ontology.yaml");
    const t = Date.now() / 1000 + 60; utimesSync(path, t, t); // stat change: an index-refreshing `git status` would rewrite .git/index
    const before = snapshot(directory);
    run("reads", "Loan.state", path);
    run("cites", "L6", path, "--json");
    expect(snapshot(directory)).toEqual(before);
    appendFileSync(path, "# changed\n");
    const dirty = json("object", "Loan", path);
    expect(dirty.envelope.stamp.git.dirty).toBe(true);
    expect(run("object", "Loan", path).stdout.split("\n")[1]).toMatch(/^commit: [0-9a-f]{40} \(dirty\)$/);
  });

  it.skipIf(!gitAvailable)("stamps a git-ignored file as dirty", () => {
    const { directory, path } = copyOntology();
    expect(git(directory, "init", "-q").status).toBe(0);
    writeFileSync(join(directory, ".gitignore"), "library.ontology.yaml\n");
    expect(git(directory, "add", ".gitignore").status).toBe(0);
    const c = git(directory, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x");
    expect(c.status, c.stderr).toBe(0);
    const r = json("object", "Loan", path);
    expect(r.status, r.stderr).toBe(0);
    expect(r.envelope.stamp.git.dirty).toBe(true);
    expect(r.envelope.stamp.git.path).toBe("library.ontology.yaml");
  });

  it("answers an out-of-scope object", () => {
    const path = patchedOntology([{ op: "add", path: "/outOfScopeObjectTypes", value: { Shelf: "not modelled" } }]);
    const r = json("object", "Shelf", path);
    expect(r.status, r.stderr).toBe(0);
    expect(r.envelope.result.outOfScope).toBe("not modelled");
    expect(run("object", "Shelf", path).stdout.split("\n")).toContain("outOfScope: not modelled");
  });

  it("escapes line breaks in text output", () => {
    const path = patchedOntology([{ op: "replace", path: "/actionTypes/BORROW/decision/rows/0/cites/0/cite/quote", value: "first line\nsecond line\r" }]);
    const r = run("action", "BORROW", path);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines).toContain("        - [L6] first line\\nsecond line\\r");
    expect(lines.some((l) => l.startsWith("second line"))).toBe(false);
    expect(json("action", "BORROW", path).envelope.result.decision.rows[0].cites[0].quote).toBe("first line\nsecond line\r");
  });

  it("prints the principals block of a {none} permission, and `principals: -` without one", () => {
    const cite = { doc: "L10", quote: "`loan:create`" };
    const path = patchedOntology([
      { op: "replace", path: "/actionTypes/BORROW/permission", value: { none: "anyone", cite, principals: { kinds: ["user"], cite } } },
      { op: "replace", path: "/actionTypes/RETURN/permission", value: { none: "anyone", cite } },
    ]);
    const withPrincipals = run("action", "BORROW", path);
    expect(withPrincipals.status, withPrincipals.stderr).toBe(0);
    const lines = withPrincipals.stdout.split("\n");
    const at = lines.indexOf("  principals:");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 3)).toEqual(["  principals:", "    kinds: user", "    cite: [L10] `loan:create`"]);
    const without = run("action", "RETURN", path);
    expect(without.status, without.stderr).toBe(0);
    expect(without.stdout.split("\n")).toContain("  principals: -");
  });

  it("runs the check with the built-in Markdown adapter configuration", () => {
    const markdown = "test/fixtures/library-markdown.json";
    const r = json("action", "BORROW", ontology, "--adapter", markdown);
    expect(r.status, r.stderr).toBe(0);
    expect(r.envelope.stamp.check).toEqual({ status: "fail", adapter: markdown, schemaErrors: 0, violations: 3, waived: 0 });
  });

  it("runs the check with an adapter", () => {
    const pass = json("action", "BORROW", ontology, "--adapter", adapter);
    expect(pass.status, pass.stderr).toBe(0);
    expect(pass.envelope.stamp.check).toEqual({ status: "pass", adapter, schemaErrors: 0, violations: 0, waived: 0 });
    const mutation = parse(readFileSync(join(root, "examples/library/mutations/lib-r8-unknown-event.yaml"), "utf8"));
    const directory = temporaryDirectory();
    const path = join(directory, "ontology.yaml");
    writeFileSync(path, stringify(applyPatch(parse(readFileSync(join(root, ontology), "utf8")), mutation.patch)));
    const fail = json("--adapter", adapter, "action", "BORROW", path);
    expect(fail.status, fail.stderr).toBe(0);
    expect(fail.envelope.stamp.check.status).toBe("fail");
    expect(fail.envelope.stamp.check.violations).toBeGreaterThanOrEqual(1);
    const text = run("action", "BORROW", ontology, "--adapter", adapter);
    expect(text.stdout.split("\n")[2]).toBe("check: pass (0 schema error(s), 0 violation(s), 0 waived)");
  });

  it("exits 1 on an empty result and still prints the envelope", () => {
    const r = json("action", "NOPE", ontology);
    expect(r.status).toBe(1);
    expect(r.envelope.result).toBeNull();
    expect(run("cites", "L99", ontology).status).toBe(1);
    expect(run("writes", "Book.nope", ontology).status).toBe(1);
  });

  it("exits 2 on usage errors and a missing file", () => {
    for (const args of [
      ["action", "BORROW"],
      ["action", "BORROW", ontology, "extra"],
      ["bogus", "x", ontology],
      ["list", "bogus", ontology],
      ["writes", "Book", ontology],
      ["reads", "a.b.c", ontology],
      ["action", "BORROW", ontology, "--bogus"],
      ["action", "BORROW", ontology, "--adapter"],
      ["action", "BORROW", "examples/library/missing.yaml"],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toContain("usage: avouch query");
      expect(r.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1);
    }
    const directory = temporaryDirectory();
    const list = join(directory, "list.yaml");
    writeFileSync(list, "- a\n- b\n");
    expect(run("action", "BORROW", list).status).toBe(2);
  });

  it("prints the stamp lines and a text rendering", () => {
    const r = run("action", "BORROW", ontology);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^ontology: /);
    expect(lines[1]).toMatch(/^commit: /);
    expect(lines[2]).toBe("check: not_run");
    expect(lines[3]).toBe("");
    expect(lines).toContain("id: BORROW");
    expect(lines).toContain("  - id: book_available");
    expect(lines).toContain('    exprText: book_id.state = "AVAILABLE"');
    expect(r.stdout).not.toContain("expr:\n");
    expect(lines).toContain("creates: Loan");
    expect(lines).toContain("idempotencyKey: -");
    expect(lines).toContain("        - [L6] BORROW by anyone other than that Member is REJECTED.");
  });

  it("dispatches subcommands and keeps the check usage", () => {
    const none = spawnSync(process.execPath, ["dist/cli/avouch.js"], { cwd: root, encoding: "utf8" });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("usage: avouch check");
    expect(none.stderr).toContain("usage: avouch query");
  });
});
