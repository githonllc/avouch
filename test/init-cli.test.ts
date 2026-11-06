// avouch init: the plugin step and the agent instructions, run with the built CLI in temporary git repositories.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAsker, pluginSpawn } from "../cli/init";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli/avouch.js");
const template = readFileSync(join(root, "templates/agents-block.md"), "utf8");
const wrapped = `<!-- BEGIN avouch -->\n${template.replace(/\n+$/, "")}\n<!-- END avouch -->\n`;
const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const directories: string[] = [];
const directory = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(d);
  return d;
};
// A PATH directory with git and, when given, a fake `claude` and a fake `codex` that record their arguments to `log` and exit with `code`.
type Fake = { log: string; code: number };
const bin = (claude?: Fake, codex?: Fake) => {
  const d = directory("avouch-init-bin-");
  symlinkSync(gitPath, join(d, "git"));
  for (const [name, fake] of [["claude", claude], ["codex", codex]] as const) {
    if (fake === undefined) continue;
    writeFileSync(join(d, name), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> '${fake.log}'; done\necho >> '${fake.log}'\nexit ${fake.code}\n`);
    chmodSync(join(d, name), 0o755);
  }
  return d;
};
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
// A git repository with the given files, committed.
const repository = (files: Record<string, string> = {}) => {
  const d = directory("avouch-init-");
  git(d, "init", "-q");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  git(d, "add", "-A");
  git(d, "commit", "-q", "--allow-empty", "-m", "init");
  return d;
};
// Runs avouch init with no TTY and, by default, a PATH with no `claude`.
const run = (cwd: string, args: string[], path = bin()) => spawnSync(process.execPath, [cli, "init", ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: path } });
const read = (d: string, name: string) => readFileSync(join(d, name), "utf8");
const bytes = (d: string, name: string) => readFileSync(join(d, name));
const ascii = (text: string) => Buffer.from(text, "latin1");

afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("avouch init", () => {
  it("not in a git repository: exit 2", () => {
    const r = run(directory("avouch-init-nogit-"), ["--print", "--no-plugin"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("git repository");
  });

  it("usage errors: exit 2 with the usage line", () => {
    const d = repository();
    for (const args of [["--append", "--print"], ["--plugin", "--no-plugin"], ["--frobnicate"], ["x"]]) {
      const r = run(d, args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: avouch init");
    }
  });

  it("the template is found from the built location and is in the package files", () => {
    const d = repository({ "AGENTS.md": "# A\n" });
    const r = run(d, ["--print", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(wrapped);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files).toContain("templates/");
  });

  it("--print prints the block and writes nothing", () => {
    const d = repository({ "AGENTS.md": "# A\n" });
    const r = run(d, ["--print", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(wrapped);
    expect(r.stdout).toContain("`@AGENTS.md`");
    expect(read(d, "AGENTS.md")).toBe("# A\n");
    expect(git(d, "status", "--porcelain").stdout).toBe("");
  });

  it("no TTY and no mode flag: prints, writes nothing", () => {
    const d = repository({ "AGENTS.md": "# A\n" });
    const r = run(d, ["--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(wrapped);
    expect(read(d, "AGENTS.md")).toBe("# A\n");
  });

  it("--append with no AGENTS.md or CLAUDE.md: creates AGENTS.md with the block, not CLAUDE.md; a second run changes nothing", () => {
    const d = repository();
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("AGENTS.md: created the file with the block");
    expect(read(d, "AGENTS.md")).toBe(wrapped);
    expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
    const again = run(d, ["--append", "--no-plugin"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("AGENTS.md: unchanged");
    expect(read(d, "AGENTS.md")).toBe(wrapped);
    expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
  });

  it("no TTY, no mode flag, no AGENTS.md: prints and creates no file", () => {
    const d = repository();
    const r = run(d, ["--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(wrapped);
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
  });

  it("--append to AGENTS.md: the content is unchanged, the block is appended, a second run changes no byte", () => {
    const content = "# Rules\n\nSome text without a final newline";
    const d = repository({ "AGENTS.md": content });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    const after = read(d, "AGENTS.md");
    expect(after.startsWith(content)).toBe(true);
    expect(after).toBe(`${content}\n\n${wrapped}`);
    const again = run(d, ["--append", "--no-plugin"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("unchanged");
    expect(read(d, "AGENTS.md")).toBe(after);
  });

  it("--append replaces an old block in place and keeps the bytes around it", () => {
    const d = repository({ "AGENTS.md": "# A\n\n<!-- BEGIN avouch -->\nold\n<!-- END avouch -->\n\n# B\n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(d, "AGENTS.md")).toBe(`# A\n\n${wrapped}\n# B\n`);
  });

  it("a CRLF file keeps CRLF", () => {
    const content = "# A\r\n\r\ntext\r\n";
    const d = repository({ "AGENTS.md": content });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    const after = read(d, "AGENTS.md");
    expect(after).toBe(`${content}\r\n${wrapped.replace(/\n/g, "\r\n")}`);
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    run(d, ["--append", "--no-plugin"]);
    expect(read(d, "AGENTS.md")).toBe(after);
  });

  it("a file with only BEGIN: an error, exit 1, the file is not changed, the other file is written", () => {
    const content = "# A\n<!-- BEGIN avouch -->\n";
    const d = repository({ "AGENTS.md": content, "CLAUDE.md": "# C\n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AGENTS.md");
    expect(read(d, "AGENTS.md")).toBe(content);
    expect(read(d, "CLAUDE.md")).toBe(`# C\n\n${wrapped}`);
  });

  it("CLAUDE.md with the line @AGENTS.md and an AGENTS.md: CLAUDE.md is skipped", () => {
    const d = repository({ "AGENTS.md": "# A\n", "CLAUDE.md": "  @AGENTS.md  \n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLAUDE.md is skipped");
    expect(read(d, "CLAUDE.md")).toBe("  @AGENTS.md  \n");
    expect(read(d, "AGENTS.md")).toBe(`# A\n\n${wrapped}`);
  });

  it("CLAUDE.md alone: the block is appended to it and AGENTS.md is created; a second run changes nothing", () => {
    const d = repository({ "CLAUDE.md": "# C\n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(d, "CLAUDE.md")).toBe(`# C\n\n${wrapped}`);
    expect(read(d, "AGENTS.md")).toBe(wrapped);
    const again = run(d, ["--append", "--no-plugin"]);
    expect(again.status, again.stderr).toBe(0);
    expect(read(d, "CLAUDE.md")).toBe(`# C\n\n${wrapped}`);
    expect(read(d, "AGENTS.md")).toBe(wrapped);
  });

  it("CLAUDE.md alone with the line @AGENTS.md: AGENTS.md is created and CLAUDE.md is skipped", () => {
    const d = repository({ "CLAUDE.md": "@AGENTS.md\n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLAUDE.md is skipped");
    expect(read(d, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(d, "AGENTS.md")).toBe(wrapped);
  });

  it("--dry-run with no AGENTS.md: says create, writes nothing", () => {
    const d = repository({ "CLAUDE.md": "# C\n" });
    const r = run(d, ["--dry-run", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Dry run: AGENTS.md: would create the file with the block");
    expect(r.stdout).toContain("Dry run: CLAUDE.md: would append the block");
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
    expect(read(d, "CLAUDE.md")).toBe("# C\n");
    expect(git(d, "status", "--porcelain").stdout).toBe("");
  });

  it("--dry-run writes nothing and says what would change", () => {
    const d = repository({ "AGENTS.md": "# A\n", "CLAUDE.md": "# C\n" });
    mkdirSync(join(d, "sub"));
    const log = join(directory("avouch-init-log-"), "argv");
    const r = spawnSync(process.execPath, [cli, "init", "--append", "--plugin", "--dry-run"], { cwd: join(d, "sub"), encoding: "utf8", env: { ...process.env, PATH: bin({ log, code: 0 }) } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Dry run: AGENTS.md: would append the block");
    expect(r.stdout).toContain("Dry run: CLAUDE.md: would append the block");
    expect(r.stdout).toContain("claude plugin install avouch@avouch");
    expect(existsSync(log)).toBe(false);
    expect(git(d, "status", "--porcelain").stdout).toBe("");
  });

  it("--no-plugin skips step 1", () => {
    const d = repository();
    const log = join(directory("avouch-init-log-"), "argv");
    const r = run(d, ["--print", "--no-plugin"], bin({ log, code: 0 }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Skipped (--no-plugin)");
    expect(r.stdout).not.toContain("claude plugin");
    expect(existsSync(log)).toBe(false);
  });

  it("no claude on PATH: prints the two commands, exit 0", () => {
    const d = repository();
    const r = run(d, ["--print", "--plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("claude plugin marketplace add githonllc/avouch");
    expect(r.stdout).toContain("claude plugin install avouch@avouch");
  });

  it("claude on PATH, no TTY and no flag: prints the commands and does not run them", () => {
    const d = repository();
    const log = join(directory("avouch-init-log-"), "argv");
    const r = run(d, ["--print"], bin({ log, code: 0 }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("claude plugin install avouch@avouch");
    expect(existsSync(log)).toBe(false);
  });

  it("--plugin runs claude with exactly the two argument lists", () => {
    const d = repository();
    const log = join(directory("avouch-init-log-"), "argv");
    const r = run(d, ["--print", "--plugin"], bin({ log, code: 0 }));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("[plugin][marketplace][add][githonllc/avouch]\n[plugin][install][avouch@avouch]\n");
    expect(r.stdout).toContain("/avouch:scan");
  });

  it("a failing claude: exit 1, and step 2 still runs", () => {
    const d = repository({ "AGENTS.md": "# A\n" });
    const log = join(directory("avouch-init-log-"), "argv");
    const r = run(d, ["--append", "--plugin"], bin({ log, code: 3 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL: claude plugin install avouch@avouch: exit 3");
    expect(readFileSync(log, "utf8").trimEnd().split("\n")).toHaveLength(2);
    expect(read(d, "AGENTS.md")).toBe(`# A\n\n${wrapped}`);
  });

  it("--plugin with claude and codex on PATH runs the two commands of claude, then the two of codex", () => {
    const d = repository();
    const logs = directory("avouch-init-log-");
    const claude = { log: join(logs, "claude"), code: 0 };
    const codex = { log: join(logs, "codex"), code: 0 };
    const r = run(d, ["--print", "--plugin"], bin(claude, codex));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(claude.log, "utf8")).toBe("[plugin][marketplace][add][githonllc/avouch]\n[plugin][install][avouch@avouch]\n");
    expect(readFileSync(codex.log, "utf8")).toBe("[plugin][marketplace][add][githonllc/avouch]\n[plugin][add][avouch@avouch]\n");
    expect(r.stdout.indexOf("Running: claude plugin install avouch@avouch")).toBeLessThan(r.stdout.indexOf("Running: codex plugin marketplace add githonllc/avouch"));
    expect(r.stdout).toContain("Step 1: the Avouch plugin for Claude Code and Codex");
    expect(r.stdout).toContain("In Codex, the hook runs only after you approve it: approve the avouch hook when Codex asks.");
  });

  it("only codex on PATH: runs codex and prints the claude commands", () => {
    const d = repository();
    const codex = { log: join(directory("avouch-init-log-"), "argv"), code: 0 };
    const r = run(d, ["--print", "--plugin"], bin(undefined, codex));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(codex.log, "utf8")).toBe("[plugin][marketplace][add][githonllc/avouch]\n[plugin][add][avouch@avouch]\n");
    expect(r.stdout).toContain("No `claude` executable is on PATH. To install the plugin, run:");
    expect(r.stdout).toContain("claude plugin install avouch@avouch");
    expect(r.stdout).toContain("In Codex, the hook runs only after you approve it");
  });

  it("neither on PATH: prints the commands of both, exit 0", () => {
    const d = repository();
    const r = run(d, ["--print", "--plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No `claude` executable is on PATH. To install the plugin, run:");
    expect(r.stdout).toContain("No `codex` executable is on PATH. To install the plugin for Codex, run:");
    expect(r.stdout).toContain("  codex plugin marketplace add githonllc/avouch");
    expect(r.stdout).toContain("  codex plugin add avouch@avouch");
    expect(r.stdout).toContain("In Codex, the hook runs only after you approve it");
  });

  it("--dry-run --plugin lists the commands of both and runs none", () => {
    const d = repository();
    const logs = directory("avouch-init-log-");
    const claude = { log: join(logs, "claude"), code: 0 };
    const codex = { log: join(logs, "codex"), code: 0 };
    const r = run(d, ["--print", "--plugin", "--dry-run"], bin(claude, codex));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("  claude plugin install avouch@avouch");
    expect(r.stdout).toContain("  codex plugin marketplace add githonllc/avouch");
    expect(r.stdout).toContain("  codex plugin add avouch@avouch");
    expect(existsSync(claude.log)).toBe(false);
    expect(existsSync(codex.log)).toBe(false);
  });

  it("a failing codex: exit 1", () => {
    const d = repository();
    const logs = directory("avouch-init-log-");
    const r = run(d, ["--print", "--plugin"], bin({ log: join(logs, "claude"), code: 0 }, { log: join(logs, "codex"), code: 4 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL: codex plugin add avouch@avouch: exit 4");
    expect(r.stderr).not.toContain("FAIL: claude");
  });

  it("the template is pure ASCII, so its bytes are the same in latin1 and UTF-8", () => {
    expect(/^[\x00-\x7f]*$/.test(template)).toBe(true);
  });

  for (const [what, fenced] of [
    ["in a fence", "```md\n<!-- BEGIN avouch -->\nKEEP\n<!-- END avouch -->\n```\n"],
    ["indented", "    <!-- BEGIN avouch -->\n    KEEP\n    <!-- END avouch -->\n"],
  ]) {
    it(`markers ${what} are not the block: the bytes are kept and the block is appended`, () => {
      const content = `# A\n\n${fenced}`;
      const d = repository({ "AGENTS.md": content });
      const r = run(d, ["--append", "--no-plugin"]);
      expect(r.status, r.stderr).toBe(0);
      expect(bytes(d, "AGENTS.md").equals(ascii(`${content}\n${wrapped}`))).toBe(true);
    });
  }

  it("a fenced example and a real block: only the real block is replaced", () => {
    const fence = "```md\n<!-- BEGIN avouch -->\nKEEP\n<!-- END avouch -->\n```\n";
    const d = repository({ "AGENTS.md": `# A\n${fence}\n<!-- BEGIN avouch -->\nold\n<!-- END avouch -->\n${fence}` });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(d, "AGENTS.md")).toBe(`# A\n${fence}\n${wrapped}${fence}`);
  });

  it("CRLF: markers in a fence are not the block", () => {
    const content = "# A\r\n```md\r\n<!-- BEGIN avouch -->\r\nKEEP\r\n<!-- END avouch -->\r\n```\r\n";
    const d = repository({ "AGENTS.md": content });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(d, "AGENTS.md")).toBe(`${content}\r\n${wrapped.replace(/\n/g, "\r\n")}`);
  });

  it("a UTF-8 BOM before the BEGIN marker on line 1: the marker is found and the BOM is kept", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const tail = ascii("\n# B\n");
    const d = repository();
    writeFileSync(join(d, "AGENTS.md"), Buffer.concat([bom, ascii("<!-- BEGIN avouch -->\nold\n<!-- END avouch -->"), tail]));
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(bytes(d, "AGENTS.md").equals(Buffer.concat([bom, ascii(wrapped), ascii("# B\n")]))).toBe(true);
  });

  it("a BOM with no block: the BOM is kept and the block is appended", () => {
    const head = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ascii("# A\n")]);
    const d = repository();
    writeFileSync(join(d, "AGENTS.md"), head);
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(bytes(d, "AGENTS.md").equals(Buffer.concat([head, ascii(`\n${wrapped}`)]))).toBe(true);
  });

  it("invalid UTF-8 and non-ASCII bytes outside the block round-trip", () => {
    const before = Buffer.concat([ascii("# A "), Buffer.from([0xff, 0xfe, 0x80]), ascii(" "), Buffer.from("caf\u00e9 \u4e2d", "utf8"), ascii("\n\n")]);
    const after = Buffer.concat([ascii("\n"), Buffer.from([0xc3, 0x28, 0xff]), ascii("\n")]);
    const d = repository();
    writeFileSync(join(d, "AGENTS.md"), Buffer.concat([before, ascii("<!-- BEGIN avouch -->\nold\n<!-- END avouch -->\n"), after]));
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(bytes(d, "AGENTS.md").equals(Buffer.concat([before, ascii(wrapped), after]))).toBe(true);
    const appended = repository();
    writeFileSync(join(appended, "AGENTS.md"), before);
    expect(run(appended, ["--append", "--no-plugin"]).status).toBe(0);
    expect(bytes(appended, "AGENTS.md").equals(Buffer.concat([before, ascii(`\n${wrapped}`)]))).toBe(true);
  });

  for (const marker of ["<!-- BEGIN avouch --> example", "<!-- END avouch --> example", "<!-- BEGIN avouchx -->"]) {
    it(`a marker line with other text (${marker}): an error, exit 1, the file is not changed`, () => {
      const content = `# A\n${marker}\n`;
      const d = repository({ "AGENTS.md": content, "CLAUDE.md": "# C\n" });
      const r = run(d, ["--append", "--no-plugin"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("AGENTS.md");
      expect(read(d, "AGENTS.md")).toBe(content);
      expect(read(d, "CLAUDE.md")).toBe(`# C\n\n${wrapped}`);
    });
  }

  it("a marker with trailing white space is the marker", () => {
    const d = repository({ "AGENTS.md": "# A\n<!-- BEGIN avouch -->  \nold\n<!-- END avouch -->\t\n# B\n" });
    const r = run(d, ["--append", "--no-plugin"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(d, "AGENTS.md")).toBe(`# A\n${wrapped}# B\n`);
  });

  it("one asker for the run: typed-ahead answers are not lost between two questions", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    input.write("n\ny\n");
    const asker = createAsker(input, output);
    try {
      expect(await asker.ask("first?")).toBe(false);
      expect(await asker.ask("second?")).toBe(true);
    } finally {
      asker.close();
    }
  });

  it("the asker at the end of input: no", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    input.end("y\n");
    const asker = createAsker(input, output);
    try {
      expect(await asker.ask("first?")).toBe(true);
      expect(await asker.ask("second?")).toBe(false);
    } finally {
      asker.close();
    }
  });

  it("spawn of claude: no shell on Unix; on Windows a shell, so claude.cmd runs", () => {
    const args = ["plugin", "install", "avouch@avouch"];
    for (const platform of ["darwin", "linux"] as const) {
      expect(pluginSpawn(args, platform)).toEqual({ command: "claude", args, options: { stdio: "inherit" } });
    }
    expect(pluginSpawn(args, "win32")).toEqual({ command: "claude plugin install avouch@avouch", args: [], options: { stdio: "inherit", shell: true } });
    expect(pluginSpawn(["plugin", "add", "avouch@avouch"], "win32", "codex")).toEqual({ command: "codex plugin add avouch@avouch", args: [], options: { stdio: "inherit", shell: true } });
    expect(pluginSpawn(args, "linux", "codex")).toEqual({ command: "codex", args, options: { stdio: "inherit" } });
  });
});
