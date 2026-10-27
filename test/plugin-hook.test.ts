import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "hooks", "ontology-read-guard.mjs");
const file = "examples/library/library.ontology.yaml";
const version: string = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
// Not a git repository, so not the Avouch repository: the rule applies.
const outside = mkdtempSync(join(tmpdir(), "avouch-hook-"));
afterAll(() => rmSync(outside, { recursive: true, force: true }));
// A working directory under `outside` that holds the given files (relative paths, empty content).
const project = (files: string[]) => {
  const dir = mkdtempSync(join(outside, "p-"));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
};
// Directories named `ontology` that hold an ontology file.
const withOntology = project(["spec/ontology/x.ontology.yaml", "ontology/x.ontology.yaml"]);
// A directory named `ontology` that holds an OWL file only.
const withOwl = project(["ontology/a.owl"]);

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
  it.each<[string, string, string?]>([
    ["grep", `grep -n member ${file}`],
    ["sed", `sed -n 10,40p ${file}`],
    ["rg on a directory named ontology", "cd /x && rg foo spec/ontology/", withOntology],
    ["python open()", `python3 -c 'print(open("${file}").read())'`],
    ["python3.12 -c behind a variable and a wrapper", `LANG=C env python3.12 -c 'print(open("${file}").read())'`],
    ["cat in a pipe", `cat ${file} | wc -l`],
    ["locate form with -A5 context", `grep -n -A5 -- 'ADD_BOOK' ${file} | cut -d: -f1`],
    ["rg on spec/ontology/", "rg foo spec/ontology/", withOntology],
    ["rg on a bare ontology/ path", "rg foo ontology/", withOntology],
    ["grep with the pattern after -e", "grep -e driver_user spec/ontology/x.ontology.yaml"],
    ["grep with a pattern and an ontology file", "grep -n driver_user spec/ontology/x.ontology.yaml"],
    ["node -e readFileSync", `node -e 'require("fs").readFileSync("docs/x.ontology.yaml")'`],
    ["locate form without -n", "grep member spec/x.ontology.yaml | cut -d: -f1"],
    ["locate form with a quoted -n in the pattern", "grep 'a -n' spec/x.ontology.yaml | cut -d: -f1"],
    ["node -e with a path", `node -e "console.log(require('fs').readFileSync('spec/x.ontology.yaml','utf8'))"`],
    ["python3 -c with a path", `python3 -c 'print(open("spec/x.ontology.yaml").read())'`],
    ["python3 - with a heredoc", "python3 - spec/x.ontology.yaml <<'EOF'\nimport sys\nprint(open(sys.argv[1]).read())\nEOF"],
    ["node < with a path", "node < spec/x.ontology.yaml"],
    ["python3 <path attached", "python3 <spec/x.ontology.yaml"],
    ["perl -ne", "perl -ne 'print' spec/x.ontology.yaml"],
    ["a directory named ontology that holds an ontology file", "grep -rn member spec/ontology/", withOntology],
    ["a read that is also redirected out", "cat spec/x.ontology.yaml > copy.txt"],
    ["an input redirect", "grep member < spec/x.ontology.yaml"],
  ])("blocks %s", (_name, command, cwd) => expectBlocked(bash(command, cwd)));

  it("blocks the Grep tool on an ontology path or glob", () => {
    expectBlocked(grep({ path: file }));
    expectBlocked(grep({ path: "spec/ontology/" }, withOntology));
    expectBlocked(grep({ path: "spec/ontology" }, withOntology));
    expectBlocked(grep({ glob: "*.ontology.yaml" }));
  });

  it("allows the Grep tool on a directory named ontology that holds no ontology file", () => {
    expectAllowed(grep({ path: "ontology" }, withOwl));
    expectAllowed(grep({ path: "ontology/" }, withOwl));
    expectAllowed(grep({ path: "no/such/ontology" }, withOwl));
  });

  it.each<[string, string, string?]>([
    ["avouch query", `npx -y @githonllc/avouch@${version} query action ADD_BOOK ${file}`],
    ["a local avouch bin", `node_modules/.bin/avouch query action ADD_BOOK ${file}`],
    ["avouch through node", `node dist/cli/avouch.js query list actions ${file}`],
    ["avouch through node and AVOUCH_CLI", `node "$AVOUCH_CLI" check ${file}`],
    ["git diff", `git diff main -- ${file}`],
    ["the line-number-only locate form", `grep -n -- 'ADD_BOOK' ${file} | cut -d: -f1 | head -n 3`],
    ["the locate form with -n", "grep -n -- BORROW spec/x.ontology.yaml | cut -d: -f1"],
    ["the locate form with -nw", "grep -nw BORROW spec/x.ontology.yaml | cut -d: -f1"],
    ["the locate form with -rn", "grep -rn -- BORROW spec/x.ontology.yaml | cut -d: -f1"],
    ["the locate form with --line-number", "rg --line-number BORROW spec/x.ontology.yaml | cut -d: -f1"],
    ["a node script that takes the path", "node scripts/build.mjs spec/x.ontology.yaml"],
    ["a python script that takes the path", "python3 tools/export.py spec/x.ontology.yaml"],
    ["a bun run script that takes the path", "bun run scripts/gen.ts spec/x.ontology.yaml"],
    ["a deno run script that takes the path", "deno run --allow-read scripts/gen.ts spec/x.ontology.yaml"],
    ["a node script with an input redirect", "node scripts/a.mjs < spec/x.ontology.yaml"],
    ["a script with -e after the script name", "node scripts/build.mjs -e spec/x.ontology.yaml"],
    ["a write with cat >", "cat > spec/x.ontology.yaml <<'EOF'\nformatVersion: 1\nEOF"],
    ["a write with cat >>", "cat >> spec/x.ontology.yaml"],
    ["a write with 2> and an attached path", "cat src/a.ts 2>spec/x.ontology.yaml"],
    ["a directory named ontology that holds no ontology file", "grep -rn Person ontology/", withOwl],
    ["a missing directory named ontology", "grep -rn Person ontology/", outside],
    ["a heredoc commit message", `git commit -F - <<'EOF'\nfix: grep ${file} comment\nEOF`],
    ["a repo-wide grep", "grep -rn member src"],
    ["a quoted search word ontology", 'grep -n "ontology" AGENTS.md'],
    ["a bare search word ontology", "grep -rn ontology src"],
    ["a search pattern that looks like an ontology path", 'grep -c "spec/ontology" src/a.mjs README.md'],
  ])("allows %s", (_name, command, cwd) => expectAllowed(bash(command, cwd)));

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
    expect(r.stderr).toContain(`npx -y @githonllc/avouch@${version} query action <ACTION_ID> -f <file>.ontology.yaml`);
    for (const verb of ["object", "writes", "reads", "cites", "list"]) expect(r.stderr).toContain(`query ${verb} `);
    expect(r.stderr).toContain("check -f <file>.ontology.yaml");
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
