// avouch --help / -h: the usage on stdout with exit 0, with no files, configuration or git.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli/avouch.js");
// a directory that is not a git repository and holds no configuration
const empty = mkdtempSync(join(tmpdir(), "avouch-help-"));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: empty, encoding: "utf8" });
const lines = (text: string) => text.trimEnd().split("\n");

afterAll(() => rmSync(empty, { recursive: true, force: true }));

// the usage lines that `avouch` prints with no command, in order
const all = lines(run().stderr);

const COMMANDS: [string[], string[]][] = [
  [["check"], [all[0]]],
  [["query"], [all[1]]],
  [["reconcile"], [all[2]]],
  [["gate"], [all[3], all[4]]],
  [["gate", "verify"], [all[3]]],
  [["gate", "docs"], [all[4]]],
];

describe("avouch --help", () => {
  it("no command and an unknown command keep the usage on stderr with exit 2", () => {
    expect(all).toHaveLength(5);
    for (const args of [[], ["frobnicate"], ["frobnicate", "--help"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      expect(lines(r.stderr)).toEqual(all);
    }
  });

  it.each(["--help", "-h"])("%s prints every usage line on stdout", (flag) => {
    const r = run(flag);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(lines(r.stdout)).toEqual(all);
  });

  it.each(["--help", "-h"])("a command with %s prints its usage on stdout", (flag) => {
    for (const [cmd, usage] of COMMANDS) {
      const r = run(...cmd, flag);
      expect(r.status, `${cmd.join(" ")} ${flag}: ${r.stderr}`).toBe(0);
      expect(r.stderr).toBe("");
      expect(lines(r.stdout)).toEqual(usage);
    }
  });

  it("the help flag wins in any position", () => {
    for (const args of [
      ["check", "-f", "x.yaml", "--help"],
      ["check", "--help", "-f", "x.yaml"],
      ["query", "cites", "--json", "-h", "x"],
      ["reconcile", "--cases", "c.jsonl", "-h"],
      ["gate", "verify", "--rows", "r.jsonl", "--baseline", "b.json", "--help"],
      ["gate", "docs", "--json", "-h"],
    ]) {
      const r = run(...args);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^usage: avouch /);
    }
  });

  it("the value of an option is not a help flag", () => {
    for (const args of [
      ["check", "-f", "--help"],
      ["check", "--config", "-h"],
      ["query", "list", "action", "--adapter", "--help"],
      ["reconcile", "--cases", "-h"],
      ["gate", "verify", "--rows", "--help"],
      ["gate", "docs", "--config", "-h"],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.stdout, args.join(" ")).not.toContain("usage:");
    }
  });
});
