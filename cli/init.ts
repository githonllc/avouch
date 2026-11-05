import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fences } from "../src/markdown.js";
import { gitTop } from "./check.js";
import { expectPositionals, parseOptions, wantsHelp } from "./reconcile.js";

export const INIT_USAGE = "usage: avouch init [--append | --print] [--plugin | --no-plugin] [--dry-run]";

const FLAGS = ["--append", "--print", "--plugin", "--no-plugin", "--dry-run"];
// The hosts of the plugin, in the order that init handles them, and the commands that install it into each.
const HOSTS = [
  { name: "claude", label: "Claude Code", suffix: "", commands: [["plugin", "marketplace", "add", "githonllc/avouch"], ["plugin", "install", "avouch@avouch"]] },
  { name: "codex", label: "Codex", suffix: " for Codex", commands: [["plugin", "marketplace", "add", "githonllc/avouch"], ["plugin", "add", "avouch@avouch"]] },
];
const CODEX_HOOK_NOTE = "In Codex, the hook runs only after you approve it: approve the avouch hook when Codex asks.";
const BEGIN = "<!-- BEGIN avouch -->";
const END = "<!-- END avouch -->";
const TARGETS = ["AGENTS.md", "CLAUDE.md"];

const isTty = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;
const commandLine = (host: string, args: string[]): string => `${host} ${args.join(" ")}`;

/**
 * Yes/no questions on one readline interface, made at the first question. Lines that arrive before a question is asked
 * (typed ahead) are queued and answer the next questions in order; at the end of input a question gets no (an empty answer).
 */
export function createAsker(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): { ask: (question: string) => Promise<boolean>; close: () => void } {
  let rl: Interface | undefined;
  let ended = false;
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  const next = (): Promise<string> => {
    if (lines.length > 0) return Promise.resolve(lines.shift()!);
    if (ended) return Promise.resolve("");
    return new Promise((resolve) => waiting.push(resolve));
  };
  return {
    ask: async (question) => {
      if (rl === undefined) {
        rl = createInterface({ input, output });
        rl.on("line", (line) => (waiting.length > 0 ? waiting.shift()!(line) : lines.push(line)));
        rl.on("close", () => {
          ended = true;
          for (const resolve of waiting.splice(0)) resolve("");
        });
      }
      if (ended) output.write(`${question} [y/N] \n`);
      else {
        rl.setPrompt(`${question} [y/N] `);
        rl.prompt();
      }
      return /^y(es)?$/i.test((await next()).trim());
    },
    close: () => rl?.close(),
  };
}

let asker = createAsker(process.stdin, process.stdout);
const ask = (question: string): Promise<boolean> => asker.ask(question);

/**
 * How to run a host (`claude` or `codex`) with fixed arguments. On Windows the host is usually `<host>.cmd`, which only a shell
 * can run; the arguments are constants, so the command line is safe for the shell. Elsewhere no shell.
 */
export function pluginSpawn(args: string[], platform: NodeJS.Platform = process.platform, host = "claude"): { command: string; args: string[]; options: SpawnSyncOptions } {
  return platform === "win32"
    ? { command: commandLine(host, args), args: [], options: { stdio: "inherit", shell: true } }
    : { command: host, args, options: { stdio: "inherit" } };
}

// True when an executable file named `name` is in a PATH directory.
function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const file of process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name]) {
      const path = join(dir, file);
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        // not there or not executable
      }
    }
  }
  return false;
}

/** The agent instructions, wrapped in the markers, with `eol` line endings. */
function wrappedBlock(eol: string): string {
  const block = readFileSync(new URL("../../templates/agents-block.md", import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return `${BEGIN}\n${block}\n${END}\n`.replace(/\n/g, eol);
}

type Plan = { file: string; action: "append" | "replace" | "unchanged"; bytes: Buffer } | { file: string; error: string };

const BOM = "\xef\xbb\xbf"; // the UTF-8 byte order mark, as latin1 text

/**
 * The new bytes of one file, or an error when its markers are not exactly one BEGIN and one END in that order. The file is
 * processed as latin1 (one byte, one character), so every byte outside the block is kept as it is, also a byte order mark
 * and bytes that are not valid UTF-8; the block is written as UTF-8. A marker line starts at column 0 and is outside a
 * fence (the fence rules of the Markdown convention); any such line that starts with "<!-- BEGIN avouch" or
 * "<!-- END avouch" is a marker candidate and must be exactly a marker, trailing white space allowed.
 */
function planFile(file: string, content: Buffer): Plan {
  const all = content.toString("latin1");
  const bom = all.startsWith(BOM) ? BOM : "";
  const body = all.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const block = Buffer.from(wrappedBlock(eol), "utf8");
  const lines = body.match(/[^\n]*(\n|$)/g)!.filter((l, i, every) => l !== "" || i < every.length - 1);
  const { inFence } = fences(lines.map((l) => l.replace(/\r?\n$/, "")));
  const candidates = lines.flatMap((l, i) => (!inFence[i] && (l.startsWith("<!-- BEGIN avouch") || l.startsWith("<!-- END avouch")) ? [i] : []));
  const bad = candidates.find((i) => ![BEGIN, END].includes(lines[i].replace(/[ \t\r\n]+$/, "")));
  if (bad !== undefined) {
    return { file, error: `${file}: line ${bad + 1} is not exactly "${BEGIN}" or "${END}": ${lines[bad].replace(/[ \t\r\n]+$/, "")}; the file is not changed` };
  }
  const begins = candidates.filter((i) => lines[i].startsWith(BEGIN));
  const ends = candidates.filter((i) => lines[i].startsWith(END));
  const latin1 = (text: string) => Buffer.from(text, "latin1");
  if (candidates.length === 0) {
    const sep = body === "" ? "" : `${/\n$/.test(body) ? "" : eol}${eol}`;
    return { file, action: "append", bytes: Buffer.concat([content, latin1(sep), block]) };
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    return { file, error: `${file}: expected one "${BEGIN}" line and then one "${END}" line, found ${begins.length} and ${ends.length}${begins.length === 1 && ends.length === 1 ? " in the wrong order" : ""}; the file is not changed` };
  }
  const bytes = Buffer.concat([latin1(bom + lines.slice(0, begins[0]).join("")), block, latin1(lines.slice(ends[0] + 1).join(""))]);
  return { file, action: bytes.equals(content) ? "unchanged" : "replace", bytes };
}

function printBlock(): void {
  console.log("Add the text between the two cut lines to AGENTS.md (and, in CLAUDE.md, the line `@AGENTS.md`) yourself:");
  console.log("-----8<----- Avouch agent instructions -----8<-----");
  process.stdout.write(wrappedBlock("\n"));
  console.log("-----8<----- end of the Avouch agent instructions -----8<-----");
}

/** Step 1, one host: install the plugin or print the commands. Returns false when a plugin command failed. */
async function pluginFor(host: (typeof HOSTS)[number], opts: Map<string, string | true>, dryRun: boolean): Promise<boolean> {
  const printCommands = (why: string) => {
    console.log(`${why} To install the plugin${host.suffix}, run:`);
    for (const c of host.commands) console.log(`  ${commandLine(host.name, c)}`);
  };
  if (!onPath(host.name)) {
    printCommands(`No \`${host.name}\` executable is on PATH.`);
    return true;
  }
  if (dryRun) {
    if (opts.has("--plugin")) {
      console.log("Dry run. These commands would run:");
      for (const c of host.commands) console.log(`  ${commandLine(host.name, c)}`);
    } else printCommands(`Dry run. Without --plugin, init would ${isTty() ? "ask before it runs these commands" : "only print these commands"}.`);
    return true;
  }
  let run = opts.has("--plugin");
  if (!run) {
    if (!isTty()) {
      printCommands("No terminal, so init does not run the commands.");
      return true;
    }
    run = await ask(`Install the Avouch plugin for ${host.label} (user scope)?`);
    if (!run) {
      printCommands("Not installed.");
      return true;
    }
  }
  let ok = true;
  // Both commands run even when the first fails: adding a marketplace that is already added can fail while the install still works.
  for (const c of host.commands) {
    console.log(`Running: ${commandLine(host.name, c)}`);
    const s = pluginSpawn(c, process.platform, host.name);
    const r = spawnSync(s.command, s.args, s.options);
    if (r.error !== undefined || r.status !== 0) {
      ok = false;
      console.error(`FAIL: ${commandLine(host.name, c)}: ${r.error !== undefined ? r.error.message : r.status !== null ? `exit ${r.status}` : `signal ${r.signal}`}`);
    }
  }
  return ok;
}

/** Step 1: the plugin for Claude Code and Codex. Returns false when a plugin command failed. */
async function plugin(opts: Map<string, string | true>, dryRun: boolean): Promise<boolean> {
  console.log("Step 1: the Avouch plugin for Claude Code and Codex (a hook that blocks text reads of an ontology, and the skills avouch:scan and avouch:cli).");
  if (opts.has("--no-plugin")) {
    console.log("Skipped (--no-plugin).");
    return true;
  }
  let ok = true;
  for (const host of HOSTS) {
    const hostOk = await pluginFor(host, opts, dryRun);
    ok = hostOk && ok;
    if (host.name === "codex" && hostOk) console.log(CODEX_HOOK_NOTE);
  }
  return ok;
}

/** Step 2: the agent instructions. Returns false when a file could not be written. */
async function instructions(top: string, opts: Map<string, string | true>, dryRun: boolean): Promise<boolean> {
  console.log("Step 2: the Avouch instructions for coding agents (AGENTS.md, CLAUDE.md).");
  const exists = (name: string) => existsSync(join(top, name)) && statSync(join(top, name)).isFile();
  const files: string[] = [];
  for (const name of TARGETS) {
    if (!exists(name)) continue;
    if (name === "CLAUDE.md" && exists("AGENTS.md") && readFileSync(join(top, name), "utf8").split(/\r?\n/).some((l) => l.trim() === "@AGENTS.md")) {
      console.log("CLAUDE.md is skipped: it has the line `@AGENTS.md`, so it imports the instructions from AGENTS.md.");
      continue;
    }
    files.push(name);
  }
  let append = opts.has("--append");
  if (!append && !opts.has("--print") && files.length > 0) {
    if (dryRun) {
      console.log("Dry run without --append or --print: this is the plan for --append (init asks in a terminal and prints otherwise).");
      append = true;
    }
    else if (isTty()) append = await ask(`Append the Avouch instructions to ${files.join(", ")}?`);
  }
  if (!append) {
    printBlock();
    return true;
  }
  if (files.length === 0) {
    console.log(`No file to append to: AGENTS.md and CLAUDE.md do not exist at ${top}, and init never creates a file.`);
    printBlock();
    return true;
  }
  let ok = true;
  for (const name of files) {
    const path = join(top, name);
    const plan = planFile(name, readFileSync(path));
    if ("error" in plan) {
      ok = false;
      console.error(`FAIL: ${plan.error}`);
      continue;
    }
    if (dryRun) {
      console.log(`Dry run: ${name}: ${plan.action === "unchanged" ? "unchanged" : `would ${plan.action === "append" ? "append the block" : "replace the block"}`}`);
      continue;
    }
    if (plan.action === "unchanged") {
      console.log(`${name}: unchanged (the block is up to date)`);
      continue;
    }
    try {
      writeFileSync(path, plan.bytes);
      console.log(`${name}: ${plan.action === "append" ? "appended the block" : "replaced the block"}`);
    } catch (error) {
      ok = false;
      console.error(`FAIL: ${name}: ${(error as Error).message}`);
    }
  }
  return ok;
}

/** `avouch init`. Exit 0: done (also the print fallback and a dry run); 1: a plugin command failed or a file could not be written; 2: a usage error or not in a git repository. */
export async function runInit(args: string[]): Promise<number> {
  if (wantsHelp(args, [])) {
    console.log(INIT_USAGE);
    return 0;
  }
  let opts: Map<string, string | true>;
  try {
    const parsed = parseOptions(args, [], FLAGS);
    expectPositionals(parsed.pos, 0);
    opts = parsed.opts;
    if (opts.has("--append") && opts.has("--print")) throw new Error("--append and --print cannot be used together");
    if (opts.has("--plugin") && opts.has("--no-plugin")) throw new Error("--plugin and --no-plugin cannot be used together");
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
    console.error(INIT_USAGE);
    return 2;
  }
  const top = gitTop(process.cwd());
  if (top === null) {
    console.error("avouch init must run inside a git repository (or git is not available)");
    return 2;
  }
  const dryRun = opts.has("--dry-run");
  let pluginOk: boolean, filesOk: boolean;
  try {
    pluginOk = await plugin(opts, dryRun);
    filesOk = await instructions(top, opts, dryRun);
  } finally {
    asker.close();
    asker = createAsker(process.stdin, process.stdout);
  }
  console.log("Step 3: next, run `/avouch:scan` in Claude Code at the top level of the repository. It drafts avouch.config.json, a first ontology and the document review ledger. The scan skill is for Claude Code only.");
  return pluginOk && filesOk ? 0 : 1;
}
