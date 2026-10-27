#!/usr/bin/env node
// PreToolUse hook (Bash, Grep): do not read an Avouch ontology (*.ontology.yaml / *.ontology.yml)
// with text tools; use `avouch query` instead.
//
// Why: grep, sed and cat print YAML comments and neighbouring entries together with the
// ontology content. A comment looks like ontology semantics, but the checker never reads
// comments. `avouch query` returns the structured permission, conditions, decision rows,
// effects and citations, with the git commit and the check status of the answer.
//
// Blocked:
//   Bash: a command segment that starts with a text reader (grep, rg, sed, awk, cat, head,
//         tail, less, python, node, yq, ...) and names a *.ontology.yaml file or a directory
//         named `ontology`. For grep, rg and the like, the search pattern does not count.
//   Grep tool: `path` names an ontology file or a directory named `ontology`, or `glob`
//         contains `ontology.yaml` / `ontology.yml`.
// Not blocked:
//   avouch itself (also `node <path>/avouch.js` and `node "$AVOUCH_CLI"`), git (diff, show and
//   log are needed for review), the Read and Edit tools (Edit needs Read), searches that do not
//   name the ontology, and the line-number-only locate form:
//     grep -n -- <anchor> <file>.ontology.yaml | cut -d: -f1 [| head [-n] N]
//   The whole rule is off when the project is the Avouch repository itself (the git top level
//   of the working directory has package.json with "name": "@githonllc/avouch"): its fixtures
//   need the raw text.
//
// Exit code 2 blocks the call; stderr is the reason that Claude sees.
// Any parse or internal error exits 0 (fail open).
// HOOK_MUTATE=1 disables the rule; it exists for mutation tests only.

import { spawnSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

const ONTO_FILE = /\.ontology\.ya?ml\b/;
// A directory named `ontology` in path form only: spec/ontology, spec/ontology/, ./ontology, ontology/.
// A search word `ontology`, bare or quoted, is not a directory.
const ONTO_DIR = /(\/ontology\/?|(^|[\s=])ontology\/)([\s'"]|$)/;
const namesOntology = (text) => ONTO_FILE.test(text) || ONTO_DIR.test(text);

const READERS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "cat", "bat",
  "head", "tail", "less", "more", "view", "vim", "nl", "cut", "strings",
  "python", "python3", "node", "deno", "bun", "ruby", "perl", "yq", "jq",
]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nice", "time", "xargs", "timeout"]);
const RUNTIMES = new Set(["node", "deno", "bun"]);
// The Avouch CLI run through a JavaScript runtime: `node dist/cli/avouch.js`, `node "$AVOUCH_CLI"`.
const AVOUCH_SCRIPT = /^['"]?(\$\{?AVOUCH_CLI\}?|(.*\/)?avouch(\.m?js)?)['"]?$/;

// Locate before an edit: a grep that prints line numbers only, no content.
const LOCATE = /^\s*(grep|rg)\s[^|;&\n]*\|\s*cut\s+-d\s*['"]?:['"]?\s*-f\s*1\s*(\|\s*head(\s+-n)?\s+-?\d+\s*)?$/;
// With context (-A/-B/-C), context lines are separated by `-`; cut prints a line without `:` whole.
const CONTEXT = /\s-(-context|[ABC])/;

function inAvouchRepo(cwd) {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000 });
    if (r.status !== 0) return false;
    const pkg = JSON.parse(readFileSync(join(r.stdout.trim(), "package.json"), "utf8"));
    return pkg.name === "@githonllc/avouch";
  } catch {
    return false;
  }
}

// Remove heredoc bodies: a file name in a commit message or an issue body is data, not a read.
function stripHeredocs(s) {
  const out = [];
  const pat = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let i = 0;
  const n = s.length;
  while (i < n) {
    pat.lastIndex = i;
    const m = pat.exec(s);
    if (!m) {
      out.push(s.slice(i));
      break;
    }
    const end = m.index + m[0].length;
    out.push(s.slice(i, end));
    const tag = m[2];
    const nl = s.indexOf("\n", end);
    if (nl === -1) break;
    let j = nl + 1;
    i = n;
    while (j < n) {
      const eol = s.indexOf("\n", j);
      const line = eol === -1 ? s.slice(j) : s.slice(j, eol);
      if (line.trim() === tag) {
        i = j + line.length;
        break;
      }
      if (eol === -1) break;
      j = eol + 1;
    }
  }
  return out.join("");
}

// Split on | ; & newline ( ) outside quotes.
function segments(cmd) {
  const segs = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if ("|;&\n()".includes(c)) {
      segs.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  segs.push(buf);
  return segs;
}

// Returns a short description of the blocked read, or null.
function verdict(input) {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();

  if (tool === "Grep") {
    const path = String(ti.path ?? "");
    const glob = String(ti.glob ?? "");
    const hit = ONTO_FILE.test(path) || basename(path.replace(/\/+$/, "")) === "ontology"
      || glob.includes("ontology.yaml") || glob.includes("ontology.yml");
    return hit && !inAvouchRepo(cwd) ? `Grep tool: ${path || glob}` : null;
  }
  if (tool !== "Bash") return null;

  let cmd = String(ti.command ?? "");
  if (!namesOntology(cmd)) return null;
  cmd = stripHeredocs(cmd);
  if (LOCATE.test(cmd) && !CONTEXT.test(cmd.split("|")[0])) return null;

  for (const seg of segments(cmd)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let k = 0;
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || WRAPPERS.has(words[k]))) k++;
    if (k >= words.length) continue;
    let first = words[k].split("/").pop();
    if (first.startsWith("python")) first = first.replace(/\d+(\.\d+)*$/, "");
    if (!READERS.has(first)) continue;
    if (RUNTIMES.has(first) && k + 1 < words.length && AVOUCH_SCRIPT.test(words[k + 1])) continue;
    const args = words.slice(k + 1);
    // For the grep family the first non-option argument is the search pattern, not a path,
    // unless -e / -f / --regexp / --file give the pattern.
    if (SEARCHERS.has(first) && !args.some((a) => /^(-(e|f)|--(regexp|file)\b)/.test(a))) {
      const p = args.findIndex((a) => !a.startsWith("-"));
      if (p !== -1) args.splice(p, 1);
    }
    if (namesOntology(args.join(" "))) {
      if (inAvouchRepo(cwd)) return null;
      return `${first}: ${seg.trim().slice(0, 160)}`;
    }
  }
  return null;
}

function pluginVersion() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const file = root ? join(root, ".claude-plugin", "plugin.json") : new URL("../.claude-plugin/plugin.json", import.meta.url);
  try {
    const version = JSON.parse(readFileSync(file, "utf8")).version;
    return typeof version === "string" && version ? version : "<version>";
  } catch {
    return "<version>";
  }
}

function reason(what) {
  const avouch = `npx -y @githonllc/avouch@${pluginVersion()}`;
  return `Blocked: do not read an Avouch ontology with text tools (${what}). Use avouch query:

  ${avouch} query action <ACTION_ID> <file>.ontology.yaml
  ${avouch} query object <Type> <file>.ontology.yaml
  ${avouch} query writes <Object>.<prop> <file>.ontology.yaml
  ${avouch} query reads <Object>.<prop> <file>.ontology.yaml
  ${avouch} query cites <anchor> <file>.ontology.yaml
  ${avouch} query list actions <file>.ontology.yaml

A project-local node_modules/.bin/avouch works too. Never run the unscoped \`npx avouch\`:
an unrelated npm package with that name exists.

Why: grep, sed and cat print YAML comments and neighbouring entries together with the ontology
content. A comment looks like ontology semantics, but the checker never reads comments. query
returns the structured permission, conditions, decision rows, effects and citations, with the
commit and the check status; quote them with the answer.

A question that query cannot answer is settled by a test case or by asking the ontology owner,
never by reading comments.

To edit the ontology (query output has no line numbers):
  1. Use avouch query to find the entry to change and what it means.
  2. Get line numbers only (the one allowed grep form; it prints no content):
       grep -n -- '<entry id or anchor>' <file>.ontology.yaml | cut -d: -f1
  3. Read that range with the Read tool (offset/limit), then change it with Edit.
  4. Run \`${avouch} check <file>.ontology.yaml\`.
`;
}

function main() {
  if (process.env.HOOK_MUTATE) return 0;
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object") return 0;
  const what = verdict(input);
  if (!what) return 0;
  writeSync(2, reason(what));
  return 2;
}

let code = 0;
try {
  code = main();
} catch {
  code = 0;
}
process.exit(code);
