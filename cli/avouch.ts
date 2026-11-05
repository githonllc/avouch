#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolveProject, runCheck } from "./check.js";
import { runFacts } from "./facts.js";
import { runInit } from "./init.js";
import { runGate } from "./gate.js";
import { runQuery } from "./query.js";
import { expectPositionals, parseOptions, runReconcile, wantsHelp } from "./reconcile.js";

const CHECK_USAGE = "usage: avouch check [-f <ontology.yaml>] [--config <avouch.config.json>] [--adapter <module|config.json>]";

async function check(args: string[]): Promise<number> {
  if (wantsHelp(args, ["-f", "--config", "--adapter"])) {
    console.log(CHECK_USAGE);
    return 0;
  }
  let opts: ReturnType<typeof parseOptions>["opts"];
  try {
    const parsed = parseOptions(args, ["-f", "--config", "--adapter"], []);
    expectPositionals(parsed.pos, 0);
    opts = parsed.opts;
  } catch (error) {
    // only an option-syntax error gets the usage line; any other error is one line (the catch around main)
    console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
    console.error(CHECK_USAGE);
    return 2;
  }
  const project = resolveProject({ file: opts.get("-f") as string | undefined, config: opts.get("--config") as string | undefined, adapter: opts.get("--adapter") as string | undefined, check: true });
  const { schemaErrors: errors, report } = await runCheck(project.file, project.adapter!);
  for (const error of errors) console.log(`SCHEMA ${error.instancePath || "/"}: ${error.message}`);
  for (const x of report.violations) console.log(`FAIL ${x.rule} ${x.kind} ${x.key}: ${x.msg}`);
  for (const line of report.info) console.log(`INFO ${line}`);
  const ok = errors.length === 0 && report.violations.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}: ${errors.length} schema error(s), ${report.violations.length} violation(s), ${report.waived.length} waived`);
  return ok ? 0 : 1;
}

const HELP = `usage: avouch <command> [options]

Check and query an Avouch ontology: a spec whose every claim cites its source.

Commands:
  init          Set up a repository: agent plugin, agent instructions
  check         Check an ontology against the schema, rules and documents
  query         Read a rule: an action, object, property or citation
  facts         Show what the Markdown adapter reads from design documents
  gate docs     Require a recorded review decision for each document change
  gate verify   Require a verified case for each decision row
  reconcile     Compare runtime results with the evaluator and expectations

Options:
  -h, --help     Show this help, or the help of a command
  -v, --version  Show the version

Run "avouch <command> --help" for the options of a command.
Docs: https://avouch.dev
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
    return 0;
  }
  if (args[0] === "check") return check(args.slice(1));
  if (args[0] === "query") return runQuery(args.slice(1));
  if (args[0] === "reconcile") return runReconcile(args.slice(1));
  if (args[0] === "gate") return runGate(args.slice(1));
  if (args[0] === "facts") return runFacts(args.slice(1));
  if (args[0] === "init") return runInit(args.slice(1));
  if (args.length > 0) console.error(`avouch: unknown command "${args[0]}"\nRun "avouch --help" for the commands.`);
  else process.stderr.write(HELP);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
  process.exitCode = 2;
}
