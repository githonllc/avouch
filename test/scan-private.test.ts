import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/scan-private.mjs");
const directories: string[] = [];

// Fixture text that the built-in patterns must find is built at run time, so this file itself stays clean.
const localPath = ["", "Users", "x", "notes"].join("/");
const token = ["ghp", "a".repeat(24)].join("_");
const keyHeader = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: cleanEnv() },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "PRIVATE_PATTERNS" || key === "REQUIRE_PRIVATE_PATTERNS" || key === "SCAN_LOG_RANGE") delete env[key];
  }
  return { ...env, ...extra };
}

const repo = (files: Record<string, string | Buffer>, message = "fixture") => {
  const directory = mkdtempSync(join(tmpdir(), "avouch-scan-"));
  directories.push(directory);
  git(directory, "init", "-q");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
  return directory;
};

const scan = (cwd: string, env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8", env: cleanEnv(env) });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("scan-private", () => {
  it("reports a secret-pattern hit by file, line and pattern number only", () => {
    const cwd = repo({ "x.md": "first line\nthe Zorblax engine\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: "# comment\n\ni:zorb\\w+\n" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("x.md:2: private pattern #1");
    expect(result.output).not.toMatch(/zorb/i);
    expect(result.output).not.toContain("engine");
  });

  it("reports a secret-pattern hit in a file path without printing the path", () => {
    const cwd = repo({ "docs/zorblax-notes.md": "nothing here\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax\ni:zorblax" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("private pattern #2");
    expect(result.output).not.toMatch(/zorb/i);
  });

  it("reports built-in hits with their public labels", () => {
    const cwd = repo({ "a.md": `see ${localPath}\n`, "b.md": `x\ny\ntoken ${token}\n`, "c.md": `${keyHeader}\n` });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("a.md:1: absolute local path");
    expect(result.output).toContain("b.md:3: secret token");
    expect(result.output).toContain("c.md:1: private key header");
    expect(result.output).not.toContain(token);
  });

  it("does not flag a word that only ends in a drive-like letter and colon", () => {
    // The URL is joined at run time, so this file does not match a stricter private path pattern.
    const cwd = repo({ "a.ts": 'expect(x).not.toContain("expr:\\n");\nsee https://example.com/' + ["home", "page"].join("/") + "\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax" });
    expect(result.status).toBe(0);
  });

  it("exits 0 with a one-line summary on a clean repository", () => {
    const cwd = repo({ "a.md": "all clean\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax" });
    expect(result.status).toBe(0);
    expect(result.output.trim().split("\n")).toHaveLength(1);
  });

  it("finds a hit in a commit message of SCAN_LOG_RANGE", () => {
    const cwd = repo({ "a.md": "clean\n" });
    writeFileSync(join(cwd, "b.md"), "clean too\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "add b\n\nfor the Zorblax engine");
    const sha = git(cwd, "rev-parse", "HEAD");
    const result = scan(cwd, { PRIVATE_PATTERNS: "i:zorblax", SCAN_LOG_RANGE: "HEAD~1..HEAD" });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`commit ${sha}: private pattern #1`);
    expect(result.output).not.toMatch(/zorb/i);
    expect(scan(cwd, { PRIVATE_PATTERNS: "i:zorblax" }).status).toBe(0);
  });

  it("fails without patterns when they are required", () => {
    const cwd = repo({ "a.md": "clean\n" });
    for (const required of ["1", "true"]) {
      const result = scan(cwd, { PRIVATE_PATTERNS: "", REQUIRE_PRIVATE_PATTERNS: required });
      expect(result.status).toBe(1);
      expect(result.output).toContain("::error::PRIVATE_PATTERNS secret is not set");
    }
  });

  it("warns and uses the built-in patterns when patterns are missing and not required", () => {
    const cwd = repo({ "a.md": `see ${localPath}\n` });
    const result = scan(cwd, { REQUIRE_PRIVATE_PATTERNS: "false" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("::warning::PRIVATE_PATTERNS not available (fork PR?); built-in patterns only");
    expect(result.output).toContain("a.md:1: absolute local path");
  });

  it("exits 2 on an invalid regex without echoing it", () => {
    const cwd = repo({ "a.md": "clean\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax\n:Quux(unclosed" });
    expect(result.status).toBe(2);
    expect(result.output).toContain("private pattern #2: invalid regex");
    expect(result.output).not.toContain("Quux");
    expect(result.output).not.toContain("Zorblax");
  });

  it("skips binary files", () => {
    const cwd = repo({ "blob.bin": Buffer.from("Zorblax\0Zorblax\n"), "a.md": "clean\n" });
    const result = scan(cwd, { PRIVATE_PATTERNS: ":Zorblax" });
    expect(result.status).toBe(0);
  });

  it("passes on its own files and the files that describe it", () => {
    const own = ["scripts/scan-private.mjs", "test/scan-private.test.ts", "README.md", ".github/workflows/ci.yml", ".github/workflows/release.yml"];
    const cwd = repo(Object.fromEntries(own.map((name) => [name, readFileSync(join(root, name))])));
    const result = scan(cwd);
    expect(result.output).toContain("::warning::");
    expect(result.status).toBe(0);
  });
});
