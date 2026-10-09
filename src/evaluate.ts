// Decision evaluation: evalValue / evalPredicate (two levels, Kleene logic) and decide (invocation layer, then decision table).
// Deterministic: no wall clock, no randomness, no global mutable state; `now` comes from the caller.
// Invalid input (ontology, snapshot, scope argument) throws; it is never a result.
import { checkPredicate, fitsType, own, RESERVED_NAMES, TIMESTAMP_MAX, TIMESTAMP_MIN, type Alt, type DecisionRow, type DispositionClass, type Expr, type Nav, type Principals, type Quantifier, type Stage1Ontology, type Type } from "./expr.js";

export type Value = string | number | boolean | null | readonly (string | number | boolean)[];
// Object rows must carry a string `id`. Pure link rows are {from, to} (plus the scope field when scoped).
export type Row = Readonly<Record<string, Value>>;
export interface Snapshot {
  objects: Record<string, readonly Row[]>;
  links?: Record<string, readonly Row[]>;
}
export type Actor = { id: string; keys: readonly string[]; kind: string };
export type Bindings = Readonly<Record<string, Value | undefined>>;
export interface Env {
  action: string;
  snapshot: Snapshot;
  scope: string | null;
  bindings: Bindings;
  actor: Actor;
  now: number;
}

export type DecideResult =
  | { layer: "invocation"; result: "INVALID_BINDING"; param: string; reason: "missing" | "unknown_param" | "type" | "not_found" }
  | { layer: "invocation"; result: "SCOPE_DENIED"; param: string }
  | { layer: "invocation"; result: "PERMISSION_DENIED" }
  | { layer: "domain"; result: string; class: DispositionClass; row: number | "otherwise"; next?: unknown }
  | { layer: "indeterminate"; reason: "unspecified"; row: number; condition: string; derived?: string }
  | { layer: "indeterminate"; reason: "no_row_matched" | "no_decision_table" | "permission_condition" | "permission_unknown" };

// The fixed invocation result set of the format (defined in ./expr). decide never returns the first two (the idempotency
// envelope is not implemented here: it has no idempotency key).
export { INVOCATION_RESULTS } from "./expr.js";

// Thrown when evaluation reads a derived property that has no expression; decide turns it into INDETERMINATE.
export class UndefinedDerived extends Error {
  constructor(readonly derived: string) {
    super(`derived property ${derived} has no expression`);
    this.name = "UndefinedDerived";
  }
}

type TV = "T" | "F" | "U";

// A field of a snapshot row. An absent key is an incomplete snapshot and throws; null is a value.
function field(row: Row, key: string, what: string): Value {
  if (!Object.hasOwn(row, key)) throw new Error(`snapshot ${what} has no ${key}`);
  return row[key];
}

type ObjVar = { type: string; row: Row | null };

// One evaluation session: caches filtered rows per type and derived values per (id, row id).
class Session {
  private rows = new Map<string, Map<string, Row>>();
  private links = new Map<string, readonly Row[]>();
  private derivedCache = new Map<string, Value>();
  private objTables: Set<string>;

  constructor(readonly ont: Stage1Ontology, readonly env: Env) {
    this.objTables = new Set(Object.values(ont.objectTypes).map((o) => o.datasource));
  }

  mode(type: string): "none" | "tenant" | "global" | "root" {
    const s = this.ont.scope;
    if (s === undefined) return "none";
    if (s.root?.type === type) return "root";
    if (s.global?.some((g) => g.type === type)) return "global";
    return "tenant";
  }

  private visible(type: string, row: Row): boolean {
    const m = this.mode(type);
    if (m === "tenant") return field(row, this.ont.scope!.by, `${type} row ${String(row.id)}`) === this.env.scope;
    if (m === "root") return row.id === this.env.scope;
    return true;
  }

  allRows(type: string): readonly Row[] {
    const rows = own(this.env.snapshot.objects, type) ?? [];
    for (const r of rows) if (typeof r.id !== "string") throw new Error(`a ${type} row has no string id`);
    return rows;
  }

  // Rows of `type` after the scope filter, by id. Lookups by id always run on filtered rows: ids repeat across tenants.
  byId(type: string): Map<string, Row> {
    let m = this.rows.get(type);
    if (m === undefined) {
      m = new Map();
      for (const r of this.allRows(type)) {
        if (!this.visible(type, r)) continue;
        if (m.has(r.id as string)) throw new Error(`snapshot has two ${type} rows with id ${String(r.id)} in one scope`);
        m.set(r.id as string, r);
      }
      this.rows.set(type, m);
    }
    return m;
  }

  linkRows(link: Stage1Ontology["linkTypes"][number]): readonly Row[] {
    let rows = this.links.get(link.id);
    if (rows === undefined) {
      const all = own(this.env.snapshot.links, link.id) ?? [];
      const by = this.ont.scope?.by;
      const tenantEnd = this.mode(link.from) === "tenant" || this.mode(link.to) === "tenant";
      rows = by !== undefined && tenantEnd ? all.filter((r) => field(r, by, `${link.id} link row`) === this.env.scope) : all;
      this.links.set(link.id, rows);
    }
    return rows;
  }

  isPureLink(link: Stage1Ontology["linkTypes"][number]): boolean {
    return link.table !== undefined && !this.objTables.has(link.table);
  }

  cachedDerived(id: string, row: Row, compute: () => Value): Value {
    const k = `${id}\u0000${String(row.id)}`;
    if (!this.derivedCache.has(k)) this.derivedCache.set(k, compute());
    return this.derivedCache.get(k)!;
  }
}

// A frame: the visible names. `action` is undefined inside a derived expression (parameters are not visible there).
type Frame = { action: string | undefined; vars: Record<string, ObjVar> };

const paramType = (ont: Stage1Ontology, action: string | undefined, name: string): Type | undefined =>
  action === undefined ? undefined : own(ont.actionTypes[action]?.parameters, name)?.type;

function objVar(s: Session, f: Frame, name: string): ObjVar | undefined {
  if (Object.hasOwn(f.vars, name)) return f.vars[name];
  const t = paramType(s.ont, f.action, name);
  if (t === undefined || typeof t === "string" || !("ref" in t)) return undefined;
  const v = own(s.env.bindings, name);
  if (v === null || v === undefined) return { type: t.ref, row: null };
  const row = s.byId(t.ref).get(v as string);
  if (row === undefined) throw new Error(`binding ${name} = ${String(v)} is not a visible ${t.ref}`);
  return { type: t.ref, row };
}

function readRef(s: Session, f: Frame, path: string): Value {
  const parts = path.split(".");
  if (parts.length > 2 || parts.some((p) => p === "")) throw new Error(`ref ${path}: at most one dot`);
  const [head, prop] = parts;
  if (head === "now") {
    if (prop !== undefined) throw new Error("now has no properties");
    return s.env.now;
  }
  if (head === "actor") {
    if (prop === "id") return s.env.actor.id;
    if (prop === "keys") return s.env.actor.keys;
    throw new Error(`actor.${prop ?? ""} is not readable; use actor.id or actor.keys`);
  }
  const o = objVar(s, f, head);
  if (prop === undefined) {
    if (o !== undefined) return o.row === null ? null : (o.row.id as string);
    if (f.action === undefined) throw new Error(`${head} is not visible in a derived property expression`);
    return own(s.env.bindings, head) ?? null;
  }
  if (o === undefined) throw new Error(`${head} is not an object binding`);
  if (o.row === null) return null;
  const v = field(o.row, prop, `${o.type} row ${String(o.row.id)}`);
  // A non-null value must fit the declared type; otherwise the snapshot is malformed.
  const t = own(s.ont.objectTypes[o.type]?.properties, prop)?.type;
  if (v !== null && t !== undefined && !fitsType(v, t))
    throw new Error(`snapshot ${o.type} row ${String(o.row.id)}: ${prop} = ${JSON.stringify(v)} does not fit its declared type`);
  return v;
}

// Out of range means malformed input (snapshot, duration, now): it throws, it is not U.
function inRange(t: number, where: string): number {
  if (!(t >= TIMESTAMP_MIN && t <= TIMESTAMP_MAX)) throw new Error(`${where}: timestamp out of supported range (${t})`);
  return t;
}

function dateIn(t: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((x) => x.type === k)!.value;
  // Timestamps are bounded so the year is 1..9999; pad it to 4 digits so dates compare as strings.
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

function value(s: Session, f: Frame, e: Expr): Value {
  if ("ref" in e) return readRef(s, f, e.ref);
  if ("lit" in e) return e.lit;
  if ("plus" in e) {
    const [a, b] = evalAll([() => value(s, f, e.plus[0]), () => value(s, f, e.plus[1])]);
    if (a === null || b === null) return null;
    const r = (a as number) + 1000 * (b as number);
    return inRange(r, "plus");
  }
  if ("dateIn" in e) {
    const [a, b] = evalAll([() => value(s, f, e.dateIn[0]), () => value(s, f, e.dateIn[1])]);
    if (a === null || b === null) return null;
    inRange(a as number, "dateIn");
    return dateIn(a as number, b as string);
  }
  if ("derived" in e) {
    const o = objVar(s, f, e.derived.of.ref);
    if (o === undefined) throw new Error(`${e.derived.of.ref} is not an object binding`);
    if (o.row === null) return null;
    const id = e.derived.id;
    const dp = own(s.ont.derivedProperties, id);
    if (dp === undefined) throw new Error(`derived property ${id} is not declared`);
    const expr = dp.expr;
    if (expr === undefined) throw new UndefinedDerived(id);
    const row = o.row;
    const frame: Frame = { action: undefined, vars: { self: { type: dp.of, row } } };
    // A predicate root (a Boolean derived property): T / F / U give true / false / null.
    return s.cachedDerived(id, row, () => (isValueNode(expr) ? value(s, frame, expr) : fromTV(predicate(s, frame, expr))));
  }
  throw new Error(`not a value expression: ${Object.keys(e)[0]}`);
}

const isValueNode = (e: Expr): boolean => "ref" in e || "lit" in e || "plus" in e || "dateIn" in e || "derived" in e;
const fromTV = (x: TV): boolean | null => (x === "T" ? true : x === "F" ? false : null);
// A boolean value in a predicate position: true / false / null give T / F / U.
function toTV(v: Value): TV {
  if (v === null) return "U";
  if (typeof v !== "boolean") throw new Error(`a predicate position holds a non-boolean value ${JSON.stringify(v)}`);
  return v ? "T" : "F";
}

const and3 = (xs: TV[]): TV => (xs.includes("F") ? "F" : xs.includes("U") ? "U" : "T");
const or3 = (xs: TV[]): TV => (xs.includes("T") ? "T" : xs.includes("U") ? "U" : "F");
const not3 = (x: TV): TV => (x === "T" ? "F" : x === "F" ? "T" : "U");
const tv = (b: boolean): TV => (b ? "T" : "F");

function navigate(s: Session, f: Frame, n: Nav): ObjVar[] {
  const { from, link: linkId, dir } = n.nav;
  const o = objVar(s, f, from.ref);
  if (o === undefined) throw new Error(`${from.ref} is not an object binding`);
  const link = s.ont.linkTypes.find((l) => l.id === linkId);
  if (link === undefined) throw new Error(`link ${linkId} is not declared`);
  const target = dir === "forward" ? link.to : link.from;
  if (o.row === null) return [];
  const fromRow = o.row;
  const targets = s.byId(target);
  const pick = (ids: Value[]) => ids.flatMap((id) => (typeof id === "string" && targets.has(id) ? [{ type: target, row: targets.get(id)! }] : []));
  if (s.isPureLink(link)) {
    const rows = s.linkRows(link);
    const end = (r: Row, k: "from" | "to") => field(r, k, `${link.id} link row`);
    return dir === "forward"
      ? pick(rows.filter((r) => end(r, "from") === fromRow.id).map((r) => end(r, "to")))
      : pick(rows.filter((r) => end(r, "to") === fromRow.id).map((r) => end(r, "from")));
  }
  if (dir === "forward") {
    const v = field(fromRow, link.via, `${link.from} row ${String(fromRow.id)}`);
    return v === null ? [] : pick([v]);
  }
  return [...targets.values()]
    .filter((r) => field(r, link.via, `${link.from} row ${String(r.id)}`) === fromRow.id)
    .map((row) => ({ type: target, row }));
}

const COMPARE = ["eq", "neq", "lt", "lte", "gt", "gte"] as const;

// Evaluates every thunk, then: the first error that is not UndefinedDerived (an invalid snapshot) is thrown; else the
// first UndefinedDerived in order is thrown; else the values are returned. So an invalid snapshot is never masked.
function evalAll<T>(thunks: (() => T)[]): T[] {
  const out: T[] = [];
  const errs: unknown[] = [];
  for (const t of thunks)
    try {
      out.push(t());
    } catch (err) {
      errs.push(err);
    }
  const invalid = errs.findIndex((err) => !(err instanceof UndefinedDerived));
  if (invalid !== -1) throw errs[invalid];
  if (errs.length > 0) throw errs[0];
  return out;
}

// No short circuit: all operands of every multi-operand node (comparisons, in, subsetOf, plus, dateIn, and, or) and all
// elements of a quantifier are evaluated (evalAll); an invalid-snapshot error takes precedence over an undefined derived
// property; the reported derived property is the first in operand order.
// An undefined derived property makes the condition undefined only when evaluation reaches it: a derived property of a
// null optional ref is null without reading its expression, and the `where` of an empty quantifier is never evaluated.
function predicate(s: Session, f: Frame, e: Expr): TV {
  for (const op of COMPARE)
    if (op in e) {
      const [x, y] = (e as Record<string, [Expr, Expr]>)[op];
      const [a, b] = evalAll([() => value(s, f, x), () => value(s, f, y)]);
      if (a === null || b === null) return "U";
      switch (op) {
        case "eq": return tv(a === b);
        case "neq": return tv(a !== b);
        case "lt": return tv(a < b);
        case "lte": return tv(a <= b);
        case "gt": return tv(a > b);
        case "gte": return tv(a >= b);
      }
    }
  if ("and" in e) return and3(evalAll(e.and.map((x) => () => predicate(s, f, x))));
  if ("or" in e) return or3(evalAll(e.or.map((x) => () => predicate(s, f, x))));
  if ("not" in e) return not3(predicate(s, f, e.not[0]));
  if ("in" in e) {
    const [a, set] = evalAll([() => value(s, f, e.in[0]), () => value(s, f, e.in[1])]);
    if (a === null || set === null) return "U";
    return tv((set as readonly (string | number | boolean)[]).includes(a as string | number | boolean));
  }
  if ("subsetOf" in e) {
    const [a, b] = evalAll([() => value(s, f, e.subsetOf[0]), () => value(s, f, e.subsetOf[1])]);
    if (a === null || b === null) return "U";
    const big = b as readonly (string | number | boolean)[];
    return tv((a as readonly (string | number | boolean)[]).every((x) => big.includes(x)));
  }
  if ("isNull" in e) return tv(value(s, f, e.isNull[0]) === null);
  if ("isNotNull" in e) return tv(value(s, f, e.isNotNull[0]) !== null);
  const quant = (q: Quantifier): TV[] =>
    evalAll(navigate(s, f, q.in).map((el) => () => (q.where === undefined ? "T" : predicate(s, { ...f, vars: { ...f.vars, [q.as]: el } }, q.where))));
  // Quantifiers are two-valued: an element counts only when its predicate is T.
  if ("exists" in e) return tv(quant(e.exists).includes("T"));
  if ("none" in e) return tv(!quant(e.none).includes("T"));
  if ("all" in e) return tv(quant(e.all).every((x) => x === "T"));
  if ("ref" in e || "derived" in e) return toTV(value(s, f, e));
  throw new Error(`not a predicate expression: ${Object.keys(e)[0]}`);
}

const topFrame = (env: Env): Frame => ({ action: env.action, vars: {} });

// Value expressions. `bindings` are taken as having passed decide's shape and binding layers.
export function evalValue(ont: Stage1Ontology, expr: Expr, env: Env): Value {
  return value(new Session(ont, env), topFrame(env), expr);
}

// Predicate expressions: T, F or U.
export function evalPredicate(ont: Stage1Ontology, expr: Expr, env: Env): TV {
  return predicate(new Session(ont, env), topFrame(env), expr);
}

type AltState = "pass" | "deny" | "undecided";
const kindAdmitted = (pr: Principals | undefined, actor: Actor): boolean => pr === undefined || pr.kinds.includes(actor.kind);
function altState(a: Alt, actor: Actor): AltState {
  if (!kindAdmitted(a.principals, actor)) return "deny";
  if (!a.keys.every((k) => actor.keys.includes(k))) return "deny";
  return (a.conditional_keys ?? []).every((k) => actor.keys.includes(k)) ? "pass" : "undecided";
}

// Shape (no snapshot reads) and permission. Returns a result to stop with, or undefined to go on.
function admit(ont: Stage1Ontology, actionId: string, bindings: Bindings, actor: Actor): DecideResult | undefined {
  const action = ont.actionTypes[actionId];
  const params = action.parameters ?? {};
  const unknown = Object.keys(bindings)
    .filter((k) => bindings[k] !== undefined && !Object.hasOwn(params, k))
    .sort()[0];
  if (unknown !== undefined) return { layer: "invocation", result: "INVALID_BINDING", param: unknown, reason: "unknown_param" };
  for (const [name, p] of Object.entries(params)) {
    const v = own(bindings, name);
    if (v === null || v === undefined) {
      if (p.optional === true) continue;
      return { layer: "invocation", result: "INVALID_BINDING", param: name, reason: "missing" };
    }
    if (!fitsType(v, p.type!)) return { layer: "invocation", result: "INVALID_BINDING", param: name, reason: "type" };
    if (Array.isArray(p.values) && !p.values.includes(v as string)) return { layer: "invocation", result: "INVALID_BINDING", param: name, reason: "type" };
  }
  const perm = action.permission;
  if (perm === "unknown") return { layer: "indeterminate", reason: "permission_unknown" };
  if ("none" in perm) return kindAdmitted(perm.principals, actor) ? undefined : { layer: "invocation", result: "PERMISSION_DENIED" };
  const states = ("any_of" in perm ? perm.any_of : [perm]).map((a) => altState(a, actor));
  if (states.includes("pass")) return undefined;
  if (states.every((x) => x === "deny")) return { layer: "invocation", result: "PERMISSION_DENIED" };
  return { layer: "indeterminate", reason: "permission_condition" };
}

const condId = (row: DecisionRow): string => ("passes" in row.when ? row.when.passes : row.when.fails);

// Binding and scope, then the decision table.
function resolve(s: Session, actionId: string): DecideResult {
  const action = s.ont.actionTypes[actionId];
  // A ref parameter binds one object; each element of a set-of-ref parameter is a referenced object too (array order).
  for (const [name, p] of Object.entries(action.parameters ?? {})) {
    const t = p.type!;
    const isSet = typeof t !== "string" && "set" in t;
    const elem = isSet ? t.set : t;
    if (typeof elem === "string" || !("ref" in elem)) continue;
    const v = own(s.env.bindings, name);
    if (v === null || v === undefined) continue;
    for (const id of isSet ? (v as readonly Value[]) : [v]) {
      if (s.byId(elem.ref).has(id as string)) continue;
      if (s.allRows(elem.ref).some((r) => r.id === id)) return { layer: "invocation", result: "SCOPE_DENIED", param: name };
      return { layer: "invocation", result: "INVALID_BINDING", param: name, reason: "not_found" };
    }
  }
  const decision = action.decision;
  if (decision === undefined) return { layer: "indeterminate", reason: "no_decision_table" };
  const frame = topFrame(s.env);
  const cache = new Map<string, TV | { undefinedDerived?: string }>();
  const disposition = (result: string) => own(s.ont.dispositions, result)!.class; // checked by decide before evaluation
  for (const [i, row] of decision.rows.entries()) {
    const id = condId(row);
    const cond = action.conditions.find((c) => c.id === id)!; // checked by decide before evaluation
    let v = cache.get(id);
    if (v === undefined) {
      if (cond.expr === undefined) v = {};
      else
        try {
          v = predicate(s, frame, cond.expr);
        } catch (err) {
          if (!(err instanceof UndefinedDerived)) throw err;
          v = { undefinedDerived: err.derived };
        }
      cache.set(id, v);
    }
    if (typeof v !== "string")
      return v.undefinedDerived === undefined
        ? { layer: "indeterminate", reason: "unspecified", row: i, condition: id }
        : { layer: "indeterminate", reason: "unspecified", row: i, condition: id, derived: v.undefinedDerived };
    if ("passes" in row.when ? v === "T" : v !== "T")
      return { layer: "domain", result: row.result, class: disposition(row.result), row: i, ...(row.next !== undefined ? { next: row.next } : {}) };
  }
  const o = decision.otherwise;
  if (o === undefined) return { layer: "indeterminate", reason: "no_row_matched" };
  return { layer: "domain", result: o.result, class: disposition(o.result), row: "otherwise", ...(o.next !== undefined ? { next: o.next } : {}) };
}

// decide(action, snapshot, scope, bindings, actor, now) of the format, plus the ontology and the action id.
// Order: shape -> permission -> (envelope, not here) -> binding and scope -> decision.
export function decide(ont: Stage1Ontology, actionId: string, snapshot: Snapshot, scope: string | null, bindings: Bindings, actor: Actor, now: number): DecideResult {
  const action = own(ont.actionTypes, actionId);
  if (action === undefined) throw new Error(`unknown action ${actionId}`);
  if (!Number.isSafeInteger(now)) throw new Error(`now must be a safe integer, found ${now}`);
  inRange(now, "now");
  if (ont.scope !== undefined && scope === null) throw new Error("the ontology declares scope, so the scope argument must not be null");
  if (ont.scope === undefined && scope !== null) throw new Error("the ontology declares no scope, so the scope argument must be null");
  const root = ont.scope?.root?.type;
  if (root !== undefined && ont.scope?.global?.some((g) => g.type === root)) throw new Error(`${root} is both global and root`);
  for (const [name, p] of Object.entries(action.parameters ?? {})) {
    if (p.type === undefined) throw new Error(`parameter ${name} has no type`);
    if ((RESERVED_NAMES as readonly string[]).includes(name)) throw new Error(`parameter ${name} uses a reserved name`);
  }
  const noDisposition = (result: string) => own(ont.dispositions, result)?.class === undefined;
  for (const [i, row] of (action.decision?.rows ?? []).entries()) {
    const id = condId(row);
    if (!action.conditions.some((c) => c.id === id)) throw new Error(`decision row ${i} names unknown condition ${id}`);
    if (noDisposition(row.result)) throw new Error(`result ${row.result} has no disposition`);
  }
  const o = action.decision?.otherwise;
  if (o !== undefined && noDisposition(o.result)) throw new Error(`result ${o.result} has no disposition`);
  for (const c of action.conditions) if (c.expr !== undefined) checkPredicate(ont, c.expr, { action: actionId, locals: {} });
  const early = admit(ont, actionId, bindings, actor);
  if (early !== undefined) return early;
  return resolve(new Session(ont, { action: actionId, snapshot, scope, bindings, actor, now }), actionId);
}

export type ExternalResult = { result: string; param?: string; reason?: "missing" | "unknown_param" | "type" | "not_found" };

// The outward projection. SCOPE_DENIED and not_found map to one value, so a caller cannot learn that an id exists in
// another tenant. Other reasons (such as type) are reported as they are.
export function externalResult(r: Exclude<DecideResult, { layer: "indeterminate" }>): ExternalResult {
  if (r.layer === "domain") return { result: r.result };
  if (r.result === "SCOPE_DENIED") return { result: "INVALID_BINDING", param: r.param, reason: "not_found" };
  if (r.result === "INVALID_BINDING") return { result: r.result, param: r.param, reason: r.reason };
  return { result: r.result };
}
