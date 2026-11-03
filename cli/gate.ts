import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyCoverage, type CoverageBaseline, type CoverageResult } from "../src/coverage.js";
import { parseLedger, unitKeyText, verifyLedger, type LedgerDoc, type LedgerResult } from "../src/ledger.js";
import type { QueryStamp } from "../src/query.js";
import type { ReconcileRow } from "../src/reconcile.js";
import { checkStamp, resolveLedger, resolveQueryProject } from "./check.js";
import { jsonLines, readJsonLines } from "./jsonl.js";
import { expectPositionals, parseOptions, readOntology, wantsHelp } from "./reconcile.js";

export const GATE_USAGE = "usage: avouch gate verify [-f <ontology.yaml>] --rows <rows.jsonl> [--baseline <baseline.json>] [--json] [--check] [--config <avouch.config.json>] [--adapter <module|config.json>]";
export const GATE_DOCS_USAGE = "usage: avouch gate docs [--config <avouch.config.json>] [--json]";

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
  const { pos, opts } = parseOptions(args, ["-f", "--rows", "--baseline", "--config", "--adapter"], ["--json", "--check"]);
  expectPositionals(pos, 0);
  const rowsFile = opts.get("--rows");
  if (typeof rowsFile !== "string") throw new Error("--rows is required");
  const baselineFile = opts.get("--baseline") as string | undefined;
  const { file, adapter } = resolveQueryProject(opts);
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
  const check = await checkStamp(file, adapter);
  const pass = result.ok && check.status !== "fail";
  process.stdout.write(opts.get("--json") === true ? `${JSON.stringify({ avouchGate: 1, gate: "verify", check, result }, null, 2)}\n` : text(check, result, pass));
  return pass ? 0 : 1;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function docsText(r: LedgerResult): string {
  const lines: string[] = [];
  for (const u of r.changed) lines.push(`FAIL changed ${unitKeyText(u)}`);
  for (const u of r.unreviewed) lines.push(`FAIL unreviewed ${unitKeyText(u)}`);
  for (const s of r.stale) lines.push(`FAIL stale ${"outline" in s ? `${s.doc} outline` : unitKeyText(s)}`);
  for (const o of r.outline) lines.push(`FAIL outline ${o.doc}`);
  for (const d of r.dangling) lines.push(`FAIL dangling ${unitKeyText(d)} ${d.pointer}`);
  lines.push(
    `${r.ok ? "PASS" : "FAIL"}: ${r.docs} document(s), ${r.units} unit(s), ${r.emptyUnits} empty unit(s); ${r.changed.length} changed, ` +
      `${r.unreviewed.length} unreviewed, ${r.stale.length} stale, ${r.outline.length} outline, ${r.dangling.length} dangling`,
  );
  return lines.join("\n") + "\n";
}

async function docs(args: string[]): Promise<number> {
  const { pos, opts } = parseOptions(args, ["--config"], ["--json"]);
  expectPositionals(pos, 0);
  const p = resolveLedger(opts.get("--config") as string | undefined);
  if (!existsSync(p.ledger)) throw new Error(`${p.ledger}: file not found`);
  let entries;
  try {
    entries = parseLedger(jsonLines(p.ledger, readFileSync(p.ledger, "utf8").replace(/^\ufeff/, "")));
  } catch (error) {
    const msg = (error as Error).message;
    throw new Error(msg.startsWith(`${p.ledger}:`) ? msg : `${p.ledger}:${msg}`);
  }
  const ont = readOntology(p.ontology);
  const texts: LedgerDoc[] = p.docs.map((doc) => {
    try {
      return { doc, text: readFileSync(resolve(p.dir, doc), "utf8") };
    } catch (error) {
      throw new Error(`${p.config}: ledger: ${doc}: ${(error as Error).message}`);
    }
  });
  const result = verifyLedger(texts, entries, ont, sha256);
  process.stdout.write(opts.get("--json") === true ? `${JSON.stringify({ avouchGate: 1, gate: "docs", result }, null, 2)}\n` : docsText(result));
  return result.ok ? 0 : 1;
}

// Exit 0: the gate passes; 1: it fails; 2: a usage, file, parse or shape error, or an adapter error (one stderr line).
export async function runGate(args: string[]): Promise<number> {
  let usage = `${GATE_USAGE}; ${GATE_DOCS_USAGE}`;
  try {
    if (args[0] === "--help" || args[0] === "-h") {
      console.log(GATE_USAGE);
      console.log(GATE_DOCS_USAGE);
      return 0;
    }
    if (args.length === 0) throw new Error("missing gate");
    if (args[0] === "verify") {
      usage = GATE_USAGE;
      if (wantsHelp(args.slice(1), ["-f", "--rows", "--baseline", "--config", "--adapter"])) {
        console.log(usage);
        return 0;
      }
      return await verify(args.slice(1));
    }
    if (args[0] === "docs") {
      usage = GATE_DOCS_USAGE;
      if (wantsHelp(args.slice(1), ["--config"])) {
        console.log(usage);
        return 0;
      }
      return await docs(args.slice(1));
    }
    throw new Error(`unknown gate ${args[0]}`);
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
    console.error(`${msg}; ${usage}`);
    return 2;
  }
}
