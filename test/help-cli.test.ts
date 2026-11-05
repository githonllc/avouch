// avouch --help / -h / --version: the output on stdout with exit 0, with no files, configuration or git.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// the usage of each command, from `<command> --help`
const usageOf = (...cmd: string[]) => lines(run(...cmd, "--help").stdout);
const all = [usageOf("check"), usageOf("query"), usageOf("reconcile"), usageOf("gate", "verify"), usageOf("gate", "docs"), usageOf("facts"), usageOf("init")].flat();

const COMMANDS: [string[], string[]][] = [
  [["check"], [all[0]]],
  [["query"], [all[1]]],
  [["reconcile"], [all[2]]],
  [["gate"], [all[3], all[4]]],
  [["gate", "verify"], [all[3]]],
  [["gate", "docs"], [all[4]]],
  [["facts"], [all[5]]],
  [["init"], [all[6]]],
];

const NAMES = ["init", "check", "query", "facts", "gate docs", "gate verify", "reconcile"];
const help = run("--help").stdout;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

describe("avouch --help", () => {
  it("each command has one usage line, or two for gate", () => {
    expect(all).toHaveLength(7);
    for (const usage of all) expect(usage).toMatch(/^usage: avouch /);
  });

  it("no command prints the overview on stderr with exit 2", () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(help);
    expect(r.stderr).toMatch(/^usage: avouch <command> \[options\]\n/);
    for (const name of NAMES) expect(r.stderr, name).toMatch(new RegExp(`^  ${name} {2,}\\S`, "m"));
  });

  it.each(["--help", "-h"])("%s prints the overview on stdout with exit 0", (flag) => {
    const r = run(flag);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(help);
    expect(r.stdout).toContain("-h, --help");
    expect(r.stdout).toContain("-v, --version");
    expect(r.stdout).toContain('Run "avouch <command> --help" for the options of a command.');
    expect(r.stdout).toContain("Docs: https://avouch.dev");
    for (const name of NAMES) expect(r.stdout, name).toMatch(new RegExp(`^  ${name} {2,}\\S`, "m"));
    // each command line is a name column and a description of at most 60 characters
    for (const line of lines(r.stdout).slice(lines(r.stdout).indexOf("Commands:") + 1, lines(r.stdout).indexOf("Options:") - 1)) {
      expect(line.slice(0, 16).trim()).not.toBe("");
      expect(line.slice(16).length).toBeLessThanOrEqual(60);
    }
  });

  it.each(["--version", "-v"])("%s prints the package version only, with exit 0", (flag) => {
    const r = run(flag);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${pkg.version}\n`);
  });

  it("an unknown command gives one message and a pointer to the help, with exit 2", () => {
    for (const args of [["frobnicate"], ["frobnicate", "--help"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      expect(lines(r.stderr)).toEqual(['avouch: unknown command "frobnicate"', 'Run "avouch --help" for the commands.']);
    }
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
      ["facts", "--json", "--help"],
      ["init", "--append", "-h"],
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
      ["facts", "--adapter", "--help"],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.stdout, args.join(" ")).not.toContain("usage:");
    }
  });
});
