#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, runCheck } from "./check.js";
import { QUERY_USAGE, runQuery } from "./query.js";

const CHECK_USAGE = "usage: avouch check <ontology.yaml> [--adapter <module|config.json>]";

async function check(args: string[]): Promise<number> {
  let adapter: string | null;
  if (args.length === 3 && args[1] === "--adapter") adapter = args[2];
  else if (args.length === 1) {
    // no --adapter: the built-in Markdown adapter with the avouch.json next to the ontology
    if (!existsSync(join(dirname(resolve(args[0])), CONFIG_FILE))) {
      console.error(`no adapter: no ${CONFIG_FILE} next to ${args[0]}; pass --adapter <module|config.json>`);
      console.error(CHECK_USAGE);
      return 2;
    }
    adapter = null;
  } else {
    console.error(CHECK_USAGE);
    return 2;
  }
  const { schemaErrors: errors, report } = await runCheck(args[0], adapter);
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
  console.error(CHECK_USAGE);
  console.error(QUERY_USAGE);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "));
  process.exitCode = 2;
}
