#!/usr/bin/env node
import { resolveProject, runCheck } from "./check.js";
import { FACTS_USAGE, runFacts } from "./facts.js";
import { INIT_USAGE, runInit } from "./init.js";
import { GATE_DOCS_USAGE, GATE_USAGE, runGate } from "./gate.js";
import { QUERY_USAGE, runQuery } from "./query.js";
import { expectPositionals, parseOptions, RECONCILE_USAGE, runReconcile, wantsHelp } from "./reconcile.js";

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

const USAGES = [CHECK_USAGE, QUERY_USAGE, RECONCILE_USAGE, GATE_USAGE, GATE_DOCS_USAGE, FACTS_USAGE, INIT_USAGE];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    for (const usage of USAGES) console.log(usage);
    return 0;
  }
  if (args[0] === "check") return check(args.slice(1));
  if (args[0] === "query") return runQuery(args.slice(1));
  if (args[0] === "reconcile") return runReconcile(args.slice(1));
  if (args[0] === "gate") return runGate(args.slice(1));
  if (args[0] === "facts") return runFacts(args.slice(1));
  if (args[0] === "init") return runInit(args.slice(1));
  for (const usage of USAGES) console.error(usage);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
  process.exitCode = 2;
}
