import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyCoverage, type CoverageBaseline, type CoverageResult } from "../src/coverage.js";
import type { QueryStamp } from "../src/query.js";
import type { ReconcileRow } from "../src/reconcile.js";
import { ontologyFile, runCheck } from "./check.js";
import { readJsonLines } from "./jsonl.js";
import { expectPositionals, parseOptions, readOntology } from "./reconcile.js";

export const GATE_USAGE = "usage: avouch gate verify [-f <ontology.yaml>] --rows <rows.jsonl> [--baseline <baseline.json>] [--json] [--adapter <module|config.json>]";

const unitText = (row: number | "otherwise") => (row === "otherwise" ? "otherwise" : `rows.${row}`);

function text(check: QueryStamp["check"], r: CoverageResult, pass: boolean): string {
  const lines: string[] = [];
  if (check.status === "fail") lines.push(`FAIL check: ${check.schemaErrors} schema error(s), ${check.violations} violation(s)`);
  for (const u of r.uncovered) lines.push(`FAIL uncovered ${u.action}:${unitText(u.row)}`);
  for (const g of r.unexempted) lines.push(`FAIL unexempted ${g.action}:${g.condition}`);
  for (const g of r.unreasoned) lines.push(`FAIL unreasoned ${g.action}:${g.condition}`);
  for (const s of r.stale)
    lines.push(s.list === "uncovered" ? `FAIL stale uncovered ${s.action}:${unitText(s.row)} ${s.why}` : `FAIL stale exempt ${s.action}:${s.condition} ${s.why}`);
  for (const f of r.failed) lines.push(`FAIL case ${f.id} ${f.action} ${f.why}`);
  lines.push(`INFO check ${check.status}`);
  for (const b of r.blocked) lines.push(`INFO blocked ${b.action}:${unitText(b.row)} by ${b.condition}`);
  for (const a of r.noTable) lines.push(`INFO no_table ${a}`);
  for (const c of r.unasserted) lines.push(`INFO unasserted ${c.id} ${c.action}`);
  lines.push(
    `${pass ? "PASS" : "FAIL"}: ${r.units} unit(s), ${r.verified.length} verified, ${r.baselined.length} baselined, ${r.blocked.length} blocked, ` +
      `${r.uncovered.length} uncovered; ${r.unexempted.length} unexempted, ${r.unreasoned.length} unreasoned, ${r.stale.length} stale, ` +
      `${r.failed.length} failed case(s), ${r.unasserted.length} unasserted`,
  );
  return lines.join("\n") + "\n";
}

async function verify(args: string[]): Promise<number> {
  const { pos, opts } = parseOptions(args, ["-f", "--rows", "--baseline", "--adapter"], ["--json"]);
  expectPositionals(pos, 0);
  const rowsFile = opts.get("--rows");
  if (typeof rowsFile !== "string") throw new Error("--rows is required");
  const baselineFile = opts.get("--baseline") as string | undefined;
  const adapter = opts.get("--adapter") as string | undefined;
  const file = ontologyFile(opts.get("-f") as string | undefined);
  const ont = readOntology(file);
  const rows = readJsonLines(rowsFile);
  let baseline: unknown = null;
  if (baselineFile !== undefined) {
    const raw = readFileSync(resolve(baselineFile), "utf8");
    try {
      baseline = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${baselineFile}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let result: CoverageResult;
  try {
    result = verifyCoverage(ont, rows as ReconcileRow[], baseline as CoverageBaseline | null);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${msg.startsWith("baseline:") ? baselineFile : msg.startsWith("ontology:") ? file : rowsFile}: ${msg}`);
  }
  let check: QueryStamp["check"] = { status: "not_run" };
  if (adapter !== undefined) {
    const { schemaErrors, report } = await runCheck(file, adapter);
    const pass = schemaErrors.length === 0 && report.violations.length === 0;
    check = { status: pass ? "pass" : "fail", adapter, schemaErrors: schemaErrors.length, violations: report.violations.length, waived: report.waived.length };
  }
  const pass = result.ok && check.status !== "fail";
  process.stdout.write(opts.get("--json") === true ? `${JSON.stringify({ avouchGate: 1, gate: "verify", check, result }, null, 2)}\n` : text(check, result, pass));
  return pass ? 0 : 1;
}

// Exit 0: the gate passes; 1: it fails; 2: a usage, file, parse or shape error, or an adapter error (one stderr line).
export async function runGate(args: string[]): Promise<number> {
  try {
    if (args.length === 0) throw new Error("missing gate");
    if (args[0] !== "verify") throw new Error(`unknown gate ${args[0]}`);
    return await verify(args.slice(1));
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
    console.error(`${msg}; ${GATE_USAGE}`);
    return 2;
  }
}
