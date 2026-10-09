// Stage 1 static checks: derived properties and types (R1, R2, R4), scope (R1, R2), dispositions (R1, R2), condition
// shape (R1) and decision tables (R1, R12). Pure: no I/O. check() (./checker) parses the scope and analyzes the expression
// conditions once (parseScope, analyzeConditions), uses both itself (R4, R6) and passes them to stage1Violations.
import { IDENT, type SourceFacts, type Violation } from "./contract.js";
import { checkPredicate, derivedPropertyType, DISPOSITION_CLASSES, INVOCATION_RESULTS, isObj, newReads, type Expr, type ExprContext, type ExprReads, type Stage1Ontology } from "./expr.js";
import { absorbingQuantifiers, mayNullIn, mayUnknown } from "./unknown.js";

type Any = any; // the ontology is untyped YAML; every field access below is guarded

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const arr = (x: unknown): Any[] => (Array.isArray(x) ? x : []);
const mapOf = (x: unknown): Record<string, Any> => (isObj(x) ? x : {});
// a key of an ontology mapping: own keys only (`in` would follow the prototype chain, e.g. "toString")
const hasKey = (m: unknown, k: unknown): k is string => isObj(m) && typeof k === "string" && Object.hasOwn(m, k);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The quotes of a `cites: [{cite}]` list.
export const quotesOf = (cites: unknown): string[] => arr(cites).map((x) => x?.cite?.quote).filter(isStr);

// ------------------------------------------------------------------------------------------ shared inputs
export interface Scope {
  by: string;
  globals: Set<string>;
  root: string | null;
  isTenant(objectType: string): boolean;
}
// The declared scope, or null when there is none or it lacks `by` / `cite` (checkScope reports that as R1).
export function parseScope(ont: Record<string, Any>): Scope | null {
  const s = ont.scope;
  if (!isObj(s) || !isStr(s.by) || !isObj(s.cite)) return null;
  const globals = new Set<string>(arr(s.global).filter((g) => isObj(g) && isStr(g.type)).map((g) => g.type));
  const root = isObj(s.root) && isStr(s.root.type) ? s.root.type : null;
  return { by: s.by, globals, root, isTenant: (o) => !globals.has(o) && o !== root };
}

// expr: the analysed expression (for a repeated condition id, the last entry with an expression)
export type ConditionAnalysis = { expr: Expr } & ({ reads: ExprReads } | { error: string });
export type ConditionAnalyses = Map<string, Map<string, ConditionAnalysis>>; // action id -> condition id -> analysis
// Type-checks every expression condition once and records what it reads.
export function analyzeConditions(ont: Record<string, Any>): ConditionAnalyses {
  const out: ConditionAnalyses = new Map();
  for (const [cid, c] of Object.entries(mapOf(ont.actionTypes))) {
    const m = new Map<string, ConditionAnalysis>();
    for (const pc of isObj(c) ? arr(c.conditions) : []) {
      if (!isObj(pc) || !isStr(pc.id) || pc.expr === undefined) continue;
      const reads = newReads();
      try {
        checkPredicate(ont as unknown as Stage1Ontology, pc.expr, { action: cid, locals: {}, collect: reads });
        m.set(pc.id, { expr: pc.expr, reads });
      } catch (e) {
        m.set(pc.id, { expr: pc.expr, error: errMsg(e) });
      }
    }
    out.set(cid, m);
  }
  return out;
}
// The property reads of an expression in the shape of hand-written `reads`: a value read `{prop, values}` when every read
// of the property is an eq / neq with a string literal, else `Object.prop`.
export function asReads(r: ExprReads): Any[] {
  const lits = new Map<string, (string | undefined)[]>();
  for (const x of r.reads) lits.set(x.prop, [...(lits.get(x.prop) ?? []), x.lit]);
  return [...lits].map(([prop, ls]) => (ls.every((l) => l !== undefined) ? { prop, values: [...new Set(ls)] } : prop));
}

type Report = (rule: string, key: string, msg: string, kind?: string) => void;
type Ctx = { ont: Record<string, Any>; facts: SourceFacts; v: Report };
const objType = (ont: Record<string, Any>, o: unknown): o is string => hasKey(ont.objectTypes, o) && isObj(ont.objectTypes[o]);

// ------------------------------------------------------------------------------------------ derived properties and types
function checkDerived({ ont, facts, v }: Ctx): void {
  for (const [dn, dp] of Object.entries(mapOf(ont.derivedProperties))) {
    if (!isObj(dp)) continue;
    const key = `derivedProperties.${dn}`;
    if (dp.expr === undefined) {
      if (dp.type !== undefined && !isObj(dp.cite)) v("R2", key, "a declared type needs a cite", "type_without_provenance");
      continue;
    }
    // with an expression, a missing type or cite is a shape error (R1 only)
    if (dp.type === undefined) v("R1", key, "a derived property with an expression needs a type");
    if (!isObj(dp.cite)) v("R1", key, "a derived property with an expression needs a cite");
    if (dp.type === undefined || !objType(ont, dp.of)) continue;
    const reads = newReads();
    try {
      derivedPropertyType(ont as unknown as Stage1Ontology, dn, reads);
    } catch (e) {
      v("R1", key, errMsg(e));
      continue;
    }
    // each quantifier body on its own: absorbingQuantifiers skips a body that reaches a derived property without expression
    for (const q of absorbingQuantifiers(ont as unknown as Stage1Ontology, facts, dp.expr, { self: dp.of, locals: {} }))
      v("R12", `${key}:${q}`, absorbsMsg(q, `derived property ${dn}`), "quantifier_absorbs_unknown");
    if (!isObj(dp.cite)) continue; // reported above (R1); its literals have nothing to be checked against
    const quotes = isStr(dp.cite.quote) ? [dp.cite.quote] : [];
    for (const x of new Set(reads.literals.map(String)))
      if (!quotes.some((q) => IDENT(x).test(q))) v("R4", `${key}:${x}`, `derived property ${dn} uses the literal ${x}, which does not appear in its cite quote`, "literal_unsupported");
  }
}

function checkPropertyTypes({ ont, v }: Ctx): void {
  for (const [name, o] of Object.entries(mapOf(ont.objectTypes)))
    for (const [pn, pr] of Object.entries(mapOf(o?.properties)))
      if (isObj(pr) && pr.type !== undefined && !isObj(pr.cite)) v("R2", `${name}.${pn}`, "a declared type needs a cite", "type_without_provenance");
}

// ------------------------------------------------------------------------------------------ scope
function checkScope({ ont, facts, v }: Ctx, scope: Scope | null): void {
  const s = ont.scope;
  if (s === undefined) return;
  if (scope === null) return v("R1", "scope", "scope needs by and cite");
  if (s.global !== undefined && !(Array.isArray(s.global) && s.global.length > 0)) v("R1", "scope", "scope.global must be a non-empty list");
  const entries: [string, unknown][] = [...arr(s.global).map((g, i): [string, unknown] => [`scope.global[${i}]`, g]), ...(s.root !== undefined ? [["scope.root", s.root] as [string, unknown]] : [])];
  const seen = new Set<string>();
  for (const [where, g] of entries) {
    if (!isObj(g) || !isObj(g.cite) || !objType(ont, g.type)) v("R1", "scope", `${where} needs a declared object type and a cite`);
    else if (seen.has(g.type)) v("R1", "scope", `${g.type} is listed twice in scope`);
    else seen.add(g.type);
  }
  if (isStr(s.cite.quote) && !IDENT(scope.by).test(s.cite.quote)) v("R2", "scope", `the scope field ${scope.by} does not appear in the scope cite quote`, "scope_by_not_in_quote");
  for (const [name, o] of Object.entries(mapOf(ont.objectTypes))) {
    // the root type has no field rule; a missing field list is reported as field_list_missing
    const fl = isObj(o) && isStr(o.doc) && name !== scope.root ? (facts.fieldList(o.doc, name)?.value ?? null) : null;
    if (!fl) continue;
    if (scope.globals.has(name) && fl.has(scope.by)) v("R2", `${name}.${scope.by}`, `${name} is global, but its field list in ${o.doc} has ${scope.by}`, "scope_field_present");
    if (!scope.globals.has(name) && !fl.has(scope.by)) v("R2", `${name}.${scope.by}`, `${name} is a tenant type, but its field list in ${o.doc} has no ${scope.by}`, "scope_field_missing");
  }
}

// ------------------------------------------------------------------------------------------ dispositions
function checkDispositions({ ont, v }: Ctx): void {
  if (ont.dispositions !== undefined && !isObj(ont.dispositions)) v("R1", "dispositions", "must be a mapping result id -> {class, cite}");
  for (const [id, d] of Object.entries(mapOf(ont.dispositions))) {
    const key = `dispositions.${id}`;
    if ((INVOCATION_RESULTS as readonly string[]).includes(id)) v("R1", key, `${id} is an invocation result; a disposition needs another name`);
    if (!isObj(d) || !(DISPOSITION_CLASSES as readonly string[]).includes(d.class) || !isObj(d.cite)) v("R1", key, `needs class (${DISPOSITION_CLASSES.join(" | ")}) and cite`);
    else if (isStr(d.cite.quote) && !IDENT(id).test(d.cite.quote)) v("R2", key, `${id} does not appear in its cite quote`, "disposition_not_in_quote");
  }
}

// ------------------------------------------------------------------------------------------ conditions (shape)
function checkConditions({ v }: Ctx, cid: string, c: Record<string, Any>, analyses: Map<string, ConditionAnalysis>): void {
  for (const pc of arr(c.conditions)) {
    if (!isObj(pc) || !isStr(pc.id)) continue; // checker.ts reports it
    const key = `actionTypes.${cid}.conditions.${pc.id}`;
    const hasE = pc.expr !== undefined, hasU = pc.unspecified !== undefined;
    if (hasE === hasU) v("R1", key, "exactly one of expr / unspecified");
    else if (hasU && !isStr(pc.unspecified)) v("R1", key, "unspecified must say what is not written");
    if (hasE && (pc.reads !== undefined || pc.reads_unspecified !== undefined)) v("R1", key, "reads and reads_unspecified go only with unspecified");
    const a = analyses.get(pc.id);
    if (a !== undefined && "error" in a) v("R1", key, a.error);
  }
}

// ------------------------------------------------------------------------------------------ decision tables
// The position cite of a row (implementation decision; facts carry no order across sections): among the cites whose
// quote names the row's result, the doc of the first one listed, and the earliest of that doc's such quotes.
function position(facts: SourceFacts, r: Record<string, Any>): { doc: string; pos: number } | null {
  const named = arr(r.cites).map((x) => x?.cite).filter((ci) => isObj(ci) && isStr(ci.doc) && isStr(ci.quote) && IDENT(r.result).test(ci.quote));
  if (named.length === 0) return null;
  const doc: string = named[0].doc;
  const s = facts.section(doc);
  if (typeof s === "string") return null;
  const ps = named.filter((ci) => ci.doc === doc).map((ci) => s.text.indexOf(ci.quote)).filter((x) => x >= 0);
  return ps.length ? { doc, pos: Math.min(...ps) } : null;
}

// Shape of one row or of otherwise (R1), its result support and an unspecified next (R12).
function checkOutcome({ ont, v }: Ctx, cid: string, label: string, r: unknown, condIds: Set<string> | null): void {
  const dk = `actionTypes.${cid}.decision`;
  if (!isObj(r)) return v("R1", dk, `${label} must be a mapping`);
  const w = r.when;
  if (condIds && !(isObj(w) && Object.keys(w).length === 1 && condIds.has(w.passes ?? w.fails))) v("R1", dk, `${label}: when must be {passes} or {fails} with a condition id of ${cid}`);
  const d = hasKey(ont.dispositions, r.result) ? ont.dispositions[r.result] : undefined;
  if (d === undefined) v("R1", dk, `${label}: result ${r.result} is not a key of dispositions`);
  if (!(Array.isArray(r.cites) && r.cites.length > 0 && r.cites.every((x: Any) => isObj(x) && isObj(x.cite)))) v("R1", dk, `${label} needs cites[{cite}]`);
  if (isObj(d) && (d.class === "pending") !== (r.next !== undefined)) v("R1", dk, `${label}: a pending result has next, and only a pending result has next`);
  const n = r.next;
  const ks = isObj(n) ? ["actions", "external", "unspecified"].filter((k) => k in n) : [];
  const nextOk =
    n === undefined ||
    (ks.length === 1 &&
      (ks[0] === "actions" ? arr(n.actions).length > 0 && n.actions.every((a: unknown) => hasKey(ont.actionTypes, a)) : ks[0] === "external" ? isStr(n.external) && isObj(n.cite) : isStr(n.unspecified)));
  if (!nextOk) v("R1", dk, `${label}: next must be {actions: [declared actions]}, {external, cite} or {unspecified}`);
  else if (ks[0] === "unspecified") v("R12", `${cid}:${label}`, `${label} of ${cid}: the next step is unspecified: ${n.unspecified}`, "next_unspecified");
  if (isStr(r.result) && !quotesOf(r.cites).some((q) => IDENT(r.result).test(q))) v("R12", `${cid}:${label}`, `${label} of ${cid}: no cite quote names its result ${r.result}`, "result_unsupported");
}

// Rows i < j with different results whose position cites are in one section must follow source order there. Rows whose
// position cites are in different sections are not compared.
function checkRowOrder({ facts, v }: Ctx, cid: string, rows: Any[]): void {
  const pos = rows.map((r) => (isObj(r) && isStr(r.result) ? position(facts, r) : null));
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = pos[i], b = pos[j];
      if (!a || !b || a.doc !== b.doc || rows[i].result === rows[j].result || a.pos < b.pos) continue;
      v("R12", `${cid}:rows.${i}:rows.${j}`, `rows.${i} (${rows[i].result}) comes before rows.${j} (${rows[j].result}), but its cite does not come earlier in ${a.doc}`, "row_order_mismatch");
    }
}

function checkDecision(ctx: Ctx, cid: string, c: Record<string, Any>, analyses: Map<string, ConditionAnalysis>): void {
  const { v } = ctx;
  const conds = arr(c.conditions).filter((pc) => isObj(pc) && isStr(pc.id));
  const d = c.decision;
  if (d === undefined) {
    if (conds.length > 0) v("R12", cid, `${cid} has conditions but no decision table`, "decision_table_missing");
    return;
  }
  const dk = `actionTypes.${cid}.decision`;
  if (!isObj(d)) return v("R1", dk, "must be {hitPolicy, order?, rows, otherwise?}");
  if (d.hitPolicy !== "first") v("R1", dk, "hitPolicy must be first");
  if (!Array.isArray(d.rows)) v("R1", dk, "rows must be a list");
  if (d.order !== undefined && !(isObj(d.order) && isObj(d.order.cite))) v("R1", dk, "order must be {cite}");
  const rows = arr(d.rows);
  const condIds = new Set<string>(conds.map((pc) => pc.id));
  rows.forEach((r, i) => checkOutcome(ctx, cid, `rows.${i}`, r, condIds));
  if (d.otherwise === undefined) v("R12", cid, `the decision table of ${cid} has no otherwise`, "otherwise_missing");
  else checkOutcome(ctx, cid, "otherwise", d.otherwise, null);
  if (new Set(rows.map((r) => r?.result)).size > 1 && d.order === undefined)
    v("R12", cid, `the rows of ${cid} give different results, but no cite says that they are checked in order`, "row_order_uncited");
  // condition_unspecified: a row uses a condition without expression, or one that reaches a derived property without one
  const used = new Set<string>(rows.map((r) => r?.when?.passes ?? r?.when?.fails).filter(isStr));
  for (const pc of conds.filter((x) => used.has(x.id))) {
    const a = analyses.get(pc.id);
    const undef = a !== undefined && "reads" in a ? [...a.reads.undefinedDerived] : [];
    if (pc.expr === undefined) v("R12", `${cid}:${pc.id}`, `a row of ${cid} uses ${pc.id}, which is not written as an expression`, "condition_unspecified");
    else if (undef.length) v("R12", `${cid}:${pc.id}`, `a row of ${cid} uses ${pc.id}, which reads the derived ${undef.join(", ")} that has no expression`, "condition_unspecified");
  }
  checkRowOrder(ctx, cid, rows);
}

// ------------------------------------------------------------------------------------------ static UNKNOWN analysis
const absorbsMsg = (q: string, where: string) =>
  `the body of the quantifier at ${q} in ${where} may be UNKNOWN, and the quantifier turns UNKNOWN into T or F; guard its nullable reads with isNotNull`;

// R12 unsafe_fallthrough and quantifier_absorbs_unknown on the expression conditions that type-check and reach no derived
// property without an expression (the absent-expression rule; for a condition it excludes the whole expression).
function checkUnknown({ ont, facts, v }: Ctx, cid: string, c: Record<string, Any>, analyses: Map<string, ConditionAnalysis>): void {
  const o = ont as unknown as Stage1Ontology;
  const byId = new Map<string, Expr>();
  for (const [id, a] of analyses) if ("reads" in a && a.reads.undefinedDerived.size === 0) byId.set(id, a.expr);
  const ectx: ExprContext = { action: cid, locals: {} };
  const mn = mayNullIn(o, facts, ectx);
  for (const [id, expr] of byId)
    for (const q of absorbingQuantifiers(o, facts, expr, ectx)) v("R12", `${cid}:${id}:${q}`, absorbsMsg(q, `condition ${id} of ${cid}`), "quantifier_absorbs_unknown");
  if (!isObj(c.decision)) return;
  const rows = arr(c.decision.rows);
  // implementation decision: Stage 1 does not analyse the other conditions, so every later row is taken as reachable;
  // but when c is U, a later fails(c) row matches, so the rows after it (and otherwise) are not reached
  const appliesOrPends = (r: Record<string, Any>) => hasKey(ont.dispositions, r.result) && ["applied", "pending"].includes(ont.dispositions[r.result]?.class);
  rows.forEach((r, i) => {
    const id = isObj(r) && isObj(r.when) ? r.when.passes : undefined;
    if (!isStr(id) || !byId.has(id)) return;
    if (!mayUnknown(o, byId.get(id)!, mn)) return;
    if (rows.slice(0, i).some((x) => isObj(x) && isObj(x.when) && x.when.fails === id)) return;
    const later = [...rows.slice(i + 1), c.decision.otherwise];
    const stop = later.findIndex((x) => isObj(x) && isObj(x.when) && x.when.fails === id);
    if (!(stop < 0 ? later : later.slice(0, stop + 1)).filter(isObj).some(appliesOrPends)) return;
    v("R12", `${cid}:rows.${i}`, `rows.${i} of ${cid} uses passes(${id}), but ${id} may be UNKNOWN; then the table can fall through to an applied or pending result. Consume it with fails(${id}) first, or guard its nullable reads`, "unsafe_fallthrough");
  });
}

export interface Stage1Context {
  ont: Record<string, Any>;
  facts: SourceFacts;
  scope: Scope | null; // parseScope(ont)
  conditions: ConditionAnalyses; // analyzeConditions(ont)
}

export function stage1Violations({ ont, facts, scope, conditions }: Stage1Context): Violation[] {
  const out: Violation[] = [];
  const ctx: Ctx = { ont, facts, v: (rule, key, msg, kind = "generic") => void out.push({ rule, key, msg, kind }) };
  checkDerived(ctx);
  checkPropertyTypes(ctx);
  checkScope(ctx, scope);
  checkDispositions(ctx);
  for (const [cid, c] of Object.entries(mapOf(ont.actionTypes))) {
    if (!isObj(c)) continue;
    const analyses = conditions.get(cid) ?? new Map<string, ConditionAnalysis>();
    checkConditions(ctx, cid, c, analyses);
    checkDecision(ctx, cid, c, analyses);
    checkUnknown(ctx, cid, c, analyses);
  }
  return out;
}
