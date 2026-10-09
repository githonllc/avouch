#!/usr/bin/env node
// Blocks private content from entering this public repository.
//
// Scans the path and every line of each file in `git ls-files`, and the commit messages of SCAN_LOG_RANGE
// when it is set. Patterns: the built-in public patterns below, plus PRIVATE_PATTERNS (one `flags:source`
// regex per line; blank lines and `#` lines are ignored), which CI reads from a repository secret.
// The output names only a file and line, a commit, and a pattern label. It never prints a pattern
// source or the matching text, and it refers to a file whose path matches a pattern by its number only.
//
// Exit codes: 0 no hit, 1 hit (or required patterns missing), 2 invalid pattern or git failure.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

// Path fragments are joined at run time so that this file does not match its own patterns.
const directories = ["Users", "home", "private", "tmp", "Volumes", ["var", "folders"].join("/")].join("|");
const builtIn = [
  {
    label: "absolute local path",
    regex: new RegExp(
      [
        `(?<![\\w.~-])/(?:${directories})/`, // Unix-like absolute path, not a URL path segment
        "(?<![^\\s\"'`(=\\[<{])~/", // home directory at the start of a token
        "(?<![A-Za-z0-9_])[A-Za-z]:\\\\(?=[\\w .$-])", // Windows drive letter
      ].join("|"),
    ),
  },
  { label: "secret token", regex: /\b(npm|ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
  { label: "private key header", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const fail = (message, code) => {
  console.log(message);
  process.exit(code);
};

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) fail(`::error::scan-private: git ${args[0]} failed`, 2);
  return result.stdout;
};

const truthy = (value) => ["1", "true"].includes((value ?? "").trim().toLowerCase());

// Private patterns: validate all of them before scanning.
const privatePatterns = [];
for (const line of (process.env.PRIVATE_PATTERNS ?? "").split("\n").map((text) => text.replace(/\r$/, ""))) {
  if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
  const label = `private pattern #${privatePatterns.length + 1}`;
  const colon = line.indexOf(":");
  let regex;
  try {
    if (colon < 0) throw new Error();
    regex = new RegExp(line.slice(colon + 1), line.slice(0, colon).replace(/[gy]/g, ""));
  } catch {
    fail(`${label}: invalid regex`, 2);
  }
  privatePatterns.push({ label, regex });
}
if (privatePatterns.length === 0) {
  if (truthy(process.env.REQUIRE_PRIVATE_PATTERNS)) fail("::error::PRIVATE_PATTERNS secret is not set", 1);
  console.log("::warning::PRIVATE_PATTERNS not available (fork PR?); built-in patterns only");
}
const patterns = [...builtIn, ...privatePatterns];
const matching = (text) => patterns.filter(({ regex }) => regex.test(text)).map(({ label }) => label);

const hits = [];

// Files: path, then each line. Binary files (with a NUL byte) and package-lock.json are skipped.
const files = git("ls-files", "-z").split("\0").filter(Boolean);
files.forEach((path, index) => {
  if (path === "package-lock.json" || path.endsWith("/package-lock.json")) return;
  const pathHits = matching(path);
  const name = pathHits.length > 0 ? `file #${index + 1}` : path;
  for (const label of pathHits) hits.push(`${name} (path): ${label}`);
  let content;
  try {
    if (!lstatSync(path).isFile()) return;
    content = readFileSync(path);
  } catch {
    return; // tracked but deleted in the working tree
  }
  if (content.includes(0)) return;
  content
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((line, number) => {
      for (const label of matching(line)) hits.push(`${name}:${number + 1}: ${label}`);
    });
});

// Commit messages of SCAN_LOG_RANGE (for example base..head of a pull request).
const range = (process.env.SCAN_LOG_RANGE ?? "").trim();
let commits = 0;
if (range !== "") {
  for (const record of git("log", "-z", "--format=%H%n%B", "--end-of-options", range, "--").split("\0")) {
    const [sha, ...lines] = record.replace(/^\n/, "").split("\n");
    if (!sha) continue;
    commits += 1;
    const labels = new Set(lines.flatMap(matching));
    for (const label of labels) hits.push(`commit ${sha}: ${label}`);
  }
}

if (hits.length > 0) {
  for (const hit of hits) console.log(hit);
  fail(`scan-private: ${hits.length} hit(s); fix them before merging (labels only, text not shown)`, 1);
}
console.log(
  `scan-private: no hits in ${files.length} files and ${commits} commit messages ` +
    `(${builtIn.length} built-in, ${privatePatterns.length} private patterns)`,
);
