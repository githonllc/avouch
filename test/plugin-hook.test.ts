import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "hooks", "ontology-read-guard.mjs");
const file = "examples/library/library.ontology.yaml";
const version: string = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
// Not a git repository, so not the Avouch repository: the rule applies.
const outside = mkdtempSync(join(tmpdir(), "avouch-hook-"));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

const environment = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.HOOK_MUTATE;
  delete env.CLAUDE_PLUGIN_ROOT;
  return { ...env, ...extra };
};
const hook = (input: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script], { input, encoding: "utf8", env: environment(extra) });
const bash = (command: string, cwd = outside, extra: Record<string, string> = {}) =>
  hook(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), extra);
const grep = (toolInput: { path?: string; glob?: string }, cwd = outside) =>
  hook(JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "member", ...toolInput }, cwd }));

const expectBlocked = (r: ReturnType<typeof hook>) => {
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("avouch query");
};
const expectAllowed = (r: ReturnType<typeof hook>) => {
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
};

describe("plugin hook: ontology read guard", () => {
  it.each([
    ["grep", `grep -n member ${file}`],
    ["sed", `sed -n 10,40p ${file}`],
    ["rg on a directory named ontology", "cd /x && rg foo spec/ontology/"],
    ["python open()", `python3 -c 'print(open("${file}").read())'`],
    ["python3.12 behind a variable and a wrapper", `LANG=C env python3.12 read.py ${file}`],
    ["cat in a pipe", `cat ${file} | wc -l`],
    ["locate form with -A5 context", `grep -n -A5 -- 'ADD_BOOK' ${file} | cut -d: -f1`],
    ["rg on spec/ontology/", "rg foo spec/ontology/"],
    ["rg on a bare ontology/ path", "rg foo ontology/"],
    ["grep with the pattern after -e", "grep -e driver_user spec/ontology/x.ontology.yaml"],
    ["grep with a pattern and an ontology file", "grep -n driver_user spec/ontology/x.ontology.yaml"],
    ["node -e readFileSync", `node -e 'require("fs").readFileSync("docs/x.ontology.yaml")'`],
  ])("blocks %s", (_name, command) => expectBlocked(bash(command)));

  it("blocks the Grep tool on an ontology path or glob", () => {
    expectBlocked(grep({ path: file }));
    expectBlocked(grep({ path: "spec/ontology/" }));
    expectBlocked(grep({ glob: "*.ontology.yaml" }));
  });

  it.each([
    ["avouch query", `npx -y @githonllc/avouch@${version} query action ADD_BOOK ${file}`],
    ["a local avouch bin", `node_modules/.bin/avouch query action ADD_BOOK ${file}`],
    ["avouch through node", `node dist/cli/avouch.js query list actions ${file}`],
    ["avouch through node and AVOUCH_CLI", `node "$AVOUCH_CLI" check ${file}`],
    ["git diff", `git diff main -- ${file}`],
    ["the line-number-only locate form", `grep -n -- 'ADD_BOOK' ${file} | cut -d: -f1 | head -n 3`],
    ["a heredoc commit message", `git commit -F - <<'EOF'\nfix: grep ${file} comment\nEOF`],
    ["a repo-wide grep", "grep -rn member src"],
    ["a quoted search word ontology", 'grep -n "ontology" AGENTS.md'],
    ["a bare search word ontology", "grep -rn ontology src"],
    ["a search pattern that looks like an ontology path", 'grep -c "spec/ontology" src/a.mjs README.md'],
  ])("allows %s", (_name, command) => expectAllowed(bash(command)));

  it("allows the Grep tool on src/", () => expectAllowed(grep({ path: "src/" })));

  it("allows other tools and fails open on bad input", () => {
    expectAllowed(hook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: outside })));
    expectAllowed(hook("not json"));
    expectAllowed(hook(""));
  });

  it("HOOK_MUTATE=1 disables the rule", () => {
    expectBlocked(bash(`grep -n member ${file}`));
    expectAllowed(bash(`grep -n member ${file}`, outside, { HOOK_MUTATE: "1" }));
  });

  it("is off inside the Avouch repository, on outside it", () => {
    expectAllowed(bash(`grep -n member ${file}`, root));
    expectAllowed(grep({ path: file }, root));
    expectBlocked(bash(`grep -n member ${file}`, outside));
  });

  it("names the plugin version in the query forms", () => {
    const r = bash(`grep -n member ${file}`);
    expect(r.stderr).toContain(`npx -y @githonllc/avouch@${version} query action <ACTION_ID>`);
    for (const verb of ["object", "writes", "reads", "cites", "list"]) expect(r.stderr).toContain(`query ${verb} `);
    expect(r.stderr).toContain("grep -n -- '<entry id or anchor>' <file>.ontology.yaml | cut -d: -f1");
    expect(bash(`grep -n member ${file}`, outside, { CLAUDE_PLUGIN_ROOT: root }).stderr).toContain(`@githonllc/avouch@${version} `);
  });

  it("hooks.json registers the script for Bash and Grep", () => {
    const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    const entries: { matcher: string; hooks: { type: string; command: string }[] }[] = config.hooks.PreToolUse;
    expect(entries.map((entry) => entry.matcher).sort()).toEqual(["Bash", "Grep"]);
    for (const entry of entries) {
      for (const h of entry.hooks) {
        expect(h.type).toBe("command");
        const path = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(h.command)?.[1];
        expect(path).toBe("hooks/ontology-read-guard.mjs");
        expect(existsSync(join(root, path!))).toBe(true);
      }
    }
  });
});
