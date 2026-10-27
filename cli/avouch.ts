#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, ontologyFile, runCheck } from "./check.js";
import { GATE_USAGE, runGate } from "./gate.js";
import { QUERY_USAGE, runQuery } from "./query.js";
import { expectPositionals, parseOptions, RECONCILE_USAGE, runReconcile } from "./reconcile.js";

const CHECK_USAGE = "usage: avouch check [-f <ontology.yaml>] [--adapter <module|config.json>]";

async function check(args: string[]): Promise<number> {
  let file: string;
  let adapter: string | null;
  try {
    const { pos, opts } = parseOptions(args, ["-f", "--adapter"], []);
    expectPositionals(pos, 0);
    file = ontologyFile(opts.get("-f") as string | undefined);
    adapter = (opts.get("--adapter") as string | undefined) ?? null;
    // no --adapter: the built-in Markdown adapter with the avouch.json next to the ontology
    if (adapter === null && !existsSync(join(dirname(resolve(file)), CONFIG_FILE)))
      throw new Error(`no adapter: no ${CONFIG_FILE} next to ${file}; pass --adapter <module|config.json>`);
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
    console.error(CHECK_USAGE);
    return 2;
  }
  const { schemaErrors: errors, report } = await runCheck(file, adapter);
  for (const error of errors) console.log(`SCHEMA ${error.instancePath || "/"}: ${error.message}`);
  for (const x of report.violations) console.log(`FAIL ${x.rule} ${x.kind} ${x.key}: ${x.msg}`);
  for (const line of report.info) console.log(`INFO ${line}`);
  const ok = errors.length === 0 && report.violations.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}: ${errors.length} schema error(s), ${report.violations.length} violation(s), ${report.waived.length} waived`);
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "check") return check(args.slice(1));
  if (args[0] === "query") return runQuery(args.slice(1));
  if (args[0] === "reconcile") return runReconcile(args.slice(1));
  if (args[0] === "gate") return runGate(args.slice(1));
  console.error(CHECK_USAGE);
  console.error(QUERY_USAGE);
  console.error(RECONCILE_USAGE);
  console.error(GATE_USAGE);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
  process.exitCode = 2;
}
