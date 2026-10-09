// Decision expressions: the AST, the semantic types, the part of an ontology the evaluator reads, and the static type check.
// No imports. The evaluator (./evaluate) assumes every expression it runs has passed checkPredicate / valueType.

export type Scalar = "enum" | "timestamp" | "duration" | "date" | "timezone" | "id" | "integer" | "boolean" | { ref: string };
// "string" exists only as a set element type (the actor's keys are a set of strings).
export type Type = Scalar | { set: Scalar | "string" };

export const SCALAR_TYPE_NAMES = ["enum", "timestamp", "duration", "date", "timezone", "id", "integer", "boolean"] as const;
export const EXPR_NODES = [
  "ref", "lit", "plus", "dateIn", "derived",
  "eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not", "in", "subsetOf", "isNull", "isNotNull",
  "exists", "none", "all", "nav",
] as const;

export type Lit = string | number | (string | number)[];
// Navigation appears only as the `in` of a quantifier.
export type Nav = { nav: { from: { ref: string }; link: string; dir: "forward" | "reverse" } };
export type Quantifier = { as: string; in: Nav; where?: Expr };
export type ValueExpr =
  | { ref: string }
  | { lit: Lit }
  | { plus: [Expr, Expr] }
  | { dateIn: [Expr, Expr] }
  | { derived: { id: string; of: { ref: string } } };
export type PredicateExpr =
  | { eq: [Expr, Expr] }
  | { neq: [Expr, Expr] }
  | { lt: [Expr, Expr] }
  | { lte: [Expr, Expr] }
  | { gt: [Expr, Expr] }
  | { gte: [Expr, Expr] }
  | { and: Expr[] }
  | { or: Expr[] }
  | { not: [Expr] }
  | { in: [Expr, Expr] }
  | { subsetOf: [Expr, Expr] }
  | { isNull: [Expr] }
  | { isNotNull: [Expr] }
  | { exists: Quantifier }
  | { none: Quantifier }
  | { all: Quantifier };
export type Expr = ValueExpr | PredicateExpr;

export const DISPOSITION_CLASSES = ["rejected", "recorded", "pending", "applied"] as const;
export type DispositionClass = (typeof DISPOSITION_CLASSES)[number];
// The fixed invocation result set of the format. The first two belong to the idempotency envelope. A disposition id may
// not be one of these names.
export const INVOCATION_RESULTS = ["REPLAYED", "IDEMPOTENCY_CONFLICT", "INVALID_BINDING", "SCOPE_DENIED", "PERMISSION_DENIED"] as const;
// principals: the actor kinds the form admits; its cite is ignored by evaluation.
export type Principals = { kinds: string[]; cite?: unknown };
export type Alt = { keys: string[]; conditional_keys?: string[]; principals?: Principals };
export type Permission = "unknown" | { none: string; principals?: Principals } | Alt | { any_of: Alt[] };
export type DecisionRow = { when: { passes: string } | { fails: string }; result: string; next?: unknown };
export type Decision = { hitPolicy: "first"; rows: DecisionRow[]; otherwise?: { result: string; next?: unknown } };
export type Condition = { id: string; expr?: Expr; unspecified?: string };
export type ActionType = {
  parameters?: Record<string, { type?: Type; optional?: true; values?: string[] }>;
  permission: Permission;
  conditions: Condition[];
  decision?: Decision;
};

// Only the keys evaluation reads; other keys (cite, cites, ...) may be present and are ignored.
export interface Stage1Ontology {
  scope?: { by: string; global?: { type: string }[]; root?: { type: string } };
  dispositions?: Record<string, { class: DispositionClass }>;
  objectTypes: Record<string, { datasource: string; properties: Record<string, { type?: Type }> }>;
  linkTypes: { id: string; from: string; to: string; via: string; table?: string }[];
  derivedProperties?: Record<string, { of: string; type?: Type; expr?: Expr }>;
  actionTypes: Record<string, ActionType>;
}

export class ExprError extends Error {
  constructor(readonly path: string, msg: string) {
    super(`${path}: ${msg}`);
    this.name = "ExprError";
  }
}

// What a type check reads, for the static checks (R4, R12). reads: each property read `<Object>.<prop>`, also through the
// expressions of the derived properties it reaches; `lit` is the string literal on the other side when the read is a
// direct operand of eq / neq. literals: the literals of the checked expression itself (set literal elements one by one),
// not of the derived properties it reaches. undefinedDerived: derived properties reached that have no expression.
export interface ExprReads {
  reads: { prop: string; lit?: string }[];
  literals: (string | number)[];
  undefinedDerived: Set<string>;
}
export const newReads = (): ExprReads => ({ reads: [], literals: [], undefinedDerived: new Set() });

// action: whose parameters are visible; self: the object type of `self` (derived expressions only);
// locals: quantifier variable -> object type. collect: optional record of what the check reads; nested: inside a
// reached derived expression (its literals are not the checked expression's own).
export type ExprContext = { action?: string; self?: string; locals: Record<string, string>; collect?: ExprReads; nested?: boolean };

const VALUE_NODES = new Set(["ref", "lit", "plus", "dateIn", "derived"]);
const COMPARE = new Set(["eq", "neq", "lt", "lte", "gt", "gte"]);
const ORDERED = new Set(["timestamp", "date", "duration", "integer"]);
// Names an expression reads without a declaration; no parameter or quantifier variable may take them.
export const RESERVED_NAMES = ["now", "actor", "self"] as const;
const RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMES);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Timestamp bounds, inclusive: 0001-01-02T00:00:00.000Z .. 9999-12-30T23:59:59.999Z. The one-day margin covers every UTC
// offset, so dateIn always gives a year from 1 to 9999.
export const TIMESTAMP_MIN = -62135510400000;
export const TIMESTAMP_MAX = 253402214399999;

export const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);
// Own keys only: a name such as `toString` must not resolve to an Object.prototype member.
export const own = <V>(r: Readonly<Record<string, V>> | undefined, k: string): V | undefined => (r !== undefined && Object.hasOwn(r, k) ? r[k] : undefined);

function nodeKey(e: unknown, path: string): string {
  if (!isObj(e)) throw new ExprError(path, "an expression must be a single-key map");
  const ks = Object.keys(e);
  if (ks.length !== 1) throw new ExprError(path, `an expression must have exactly one key, found ${ks.length}`);
  return ks[0];
}

function args(e: Record<string, unknown>, k: string, n: number | "2+", path: string): unknown[] {
  const a = e[k];
  if (!Array.isArray(a)) throw new ExprError(path, `${k} takes an array of operands`);
  if (n === "2+" ? a.length < 2 : a.length !== n) throw new ExprError(path, `${k} takes ${n === "2+" ? "at least 2" : n} operands, found ${a.length}`);
  return a;
}

const isLit = (e: unknown): e is { lit: unknown } => isObj(e) && Object.keys(e).length === 1 && "lit" in e;

export function typeEquals(a: Type | "string", b: Type | "string"): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if ("ref" in a) return "ref" in b && a.ref === b.ref;
  if ("set" in a) return "set" in b && typeEquals(a.set, b.set);
  return false;
}

const showType = (t: Type | "string"): string =>
  typeof t === "string" ? t : "ref" in t ? `{ref: ${t.ref}}` : `{set: ${showType(t.set)}}`;

const isSet = (t: Type): t is { set: Scalar | "string" } => typeof t !== "string" && "set" in t;

export function validTimezone(v: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

// The one format table, for literals and for parameter values alike.
export function fitsType(v: unknown, t: Type | "string"): boolean {
  if (typeof t !== "string") {
    if ("set" in t) {
      const el = t.set;
      return Array.isArray(v) && v.every((x) => fitsType(x, el));
    }
    return typeof v === "string" && v !== "";
  }
  switch (t) {
    case "id":
      return typeof v === "string" && v !== "";
    case "enum":
    case "string":
      return typeof v === "string";
    case "timezone":
      return typeof v === "string" && validTimezone(v);
    case "date":
      return typeof v === "string" && DATE_RE.test(v);
    case "timestamp":
      return Number.isSafeInteger(v) && (v as number) >= TIMESTAMP_MIN && (v as number) <= TIMESTAMP_MAX;
    case "duration":
    case "integer":
      return Number.isSafeInteger(v);
    case "boolean":
      return typeof v === "boolean";
  }
}

// A literal is a string, a number, or an array of them; there are no Boolean literals.
const isLitValue = (v: unknown): boolean =>
  typeof v === "string" || typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number"));
const litFits = (v: unknown, t: Type | "string"): boolean => isLitValue(v) && fitsType(v, t);
// A literal in a position of type t; a set literal is non-empty with elements of one JSON type. Records the literal.
function literal(v: unknown, t: Type | "string", ctx: ExprContext, at: string): void {
  if (Array.isArray(v) && v.length === 0) throw new ExprError(at, "a set literal must not be empty");
  if (Array.isArray(v) && new Set(v.map((x) => typeof x)).size > 1) throw new ExprError(at, `set literal ${JSON.stringify(v)} mixes element types`);
  if (!litFits(v, t)) throw new ExprError(at, `literal ${JSON.stringify(v)} does not fit ${showType(t)}`);
  if (ctx.collect && !ctx.nested) ctx.collect.literals.push(...(Array.isArray(v) ? v : [v as string | number]));
}

// An object binding: a ref-typed parameter of the action, a quantifier variable, or `self`. Returns its object type.
export function objectBinding(ont: Stage1Ontology, name: string, ctx: ExprContext): string | undefined {
  if (name === "self") return ctx.self;
  if (Object.hasOwn(ctx.locals, name)) return ctx.locals[name];
  if (ctx.action === undefined) return undefined;
  const t = own(ont.actionTypes[ctx.action]?.parameters, name)?.type;
  return t !== undefined && typeof t !== "string" && "ref" in t ? t.ref : undefined;
}

function refType(ont: Stage1Ontology, path: string, ctx: ExprContext, at: string): Type {
  const parts = path.split(".");
  if (parts.length > 2 || parts.some((p) => p === "")) throw new ExprError(at, `ref ${path}: at most one dot`);
  const [head, prop] = parts;
  if (head === "now") {
    if (prop !== undefined) throw new ExprError(at, "now has no properties");
    return "timestamp";
  }
  if (head === "actor") {
    if (prop === "id") return "id";
    if (prop === "keys") return { set: "string" };
    throw new ExprError(at, `actor.${prop ?? ""} is not readable; use actor.id or actor.keys`);
  }
  if (head === "self" && ctx.self === undefined) throw new ExprError(at, "self is valid only in a derived property expression");
  const obj = objectBinding(ont, head, ctx);
  if (obj !== undefined && own(ont.objectTypes, obj) === undefined) throw new ExprError(at, `object type ${obj} is not declared`);
  if (prop === undefined) {
    if (obj !== undefined) return { ref: obj };
    if (ctx.action === undefined) throw new ExprError(at, `${head} is not visible here`);
    const p = own(ont.actionTypes[ctx.action]?.parameters, head);
    if (p === undefined) throw new ExprError(at, `${head} is not a parameter, a binding or a reserved name`);
    if (p.type === undefined) throw new ExprError(at, `parameter ${head} has no type`);
    return p.type;
  }
  if (obj === undefined) throw new ExprError(at, `${head} is not an object binding`);
  if (own(ont.derivedProperties, prop)?.of === obj)
    throw new ExprError(at, `${prop} is a derived property; read it with {derived: {id, of}}`);
  const t = own(ont.objectTypes[obj].properties, prop)?.type;
  if (t === undefined) throw new ExprError(at, `${obj}.${prop} is not a declared property with a type`);
  ctx.collect?.reads.push({ prop: `${obj}.${prop}` });
  return t;
}

function bindingName(ont: Stage1Ontology, from: unknown, ctx: ExprContext, at: string): string {
  if (!isObj(from) || typeof from.ref !== "string" || Object.keys(from).length !== 1) throw new ExprError(at, "expected {ref: <binding name>}");
  if (from.ref.includes(".")) throw new ExprError(at, `${from.ref}: a binding name has no dot`);
  const t = objectBinding(ont, from.ref, ctx);
  if (t === undefined) throw new ExprError(at, `${from.ref} is not an object binding`);
  return t;
}

// top: the derived property is the checked expression itself (its literals are recorded), not one reached from another.
function derivedType(ont: Stage1Ontology, id: string, at: string, stack: string[], collect?: ExprReads, top = false): Type {
  const dp = own(ont.derivedProperties, id);
  if (dp === undefined) throw new ExprError(at, `derived property ${id} is not declared`);
  if (dp.type === undefined) throw new ExprError(at, `derived property ${id} has no type`);
  if (dp.expr === undefined) collect?.undefinedDerived.add(id);
  else {
    const ctx: ExprContext = { self: dp.of, locals: {}, collect, nested: !top };
    if (stack.includes(id)) throw new ExprError(at, `derived properties form a cycle: ${[...stack, id].join(" -> ")}`);
    const where = `${at}<${id}>`;
    const k = nodeKey(dp.expr, where);
    if (!VALUE_NODES.has(k)) {
      // A predicate root is a Boolean expression: the declared type must be boolean.
      if (dp.type !== "boolean") throw new ExprError(at, `derived property ${id}: a predicate expression needs the declared type boolean, not ${showType(dp.type)}`);
      checkPredicateIn(ont, dp.expr, ctx, where, [...stack, id]);
    } else {
      // A boolean derived property has a predicate root (its definition is a Boolean expression).
      if (dp.type === "boolean") throw new ExprError(at, `derived property ${id}: declared boolean, so its expression root must be a predicate, not ${k}`);
      const t = valueTypeIn(ont, dp.expr, ctx, dp.type, where, [...stack, id]);
      if (!typeEquals(t, dp.type)) throw new ExprError(at, `derived property ${id}: expression type ${showType(t)} is not the declared ${showType(dp.type)}`);
    }
  }
  return dp.type;
}

function operand(ont: Stage1Ontology, e: unknown, ctx: ExprContext, want: Type, at: string, stack: string[]): void {
  const t = valueTypeIn(ont, e, ctx, want, at, stack);
  if (!typeEquals(t, want)) throw new ExprError(at, `expected ${showType(want)}, found ${showType(t)}`);
}

function valueTypeIn(ont: Stage1Ontology, e: unknown, ctx: ExprContext, expected: Type | undefined, at: string, stack: string[]): Type {
  const k = nodeKey(e, at);
  const node = e as Record<string, unknown>;
  const p = `${at}.${k}`;
  switch (k) {
    case "ref":
      if (typeof node.ref !== "string") throw new ExprError(p, "ref takes a path string");
      return refType(ont, node.ref, ctx, p);
    case "lit":
      if (expected === undefined) throw new ExprError(p, "a literal takes its type from its position, and this position gives none");
      if (expected === "boolean") throw new ExprError(p, "there are no boolean literals; write x or not(x)");
      literal(node.lit, expected, ctx, p);
      return expected;
    case "plus":
    case "dateIn": {
      const [a, b] = args(node, k, 2, p);
      if (isLit(a) && isLit(b)) throw new ExprError(p, `${k} with two literal operands`);
      operand(ont, a, ctx, "timestamp", `${p}[0]`, stack);
      operand(ont, b, ctx, k === "plus" ? "duration" : "timezone", `${p}[1]`, stack);
      return k === "plus" ? "timestamp" : "date";
    }
    case "derived": {
      const d = node.derived;
      if (!isObj(d) || typeof d.id !== "string") throw new ExprError(p, "derived takes {id, of: {ref}}");
      const of = bindingName(ont, d.of, ctx, `${p}.of`);
      const dp = own(ont.derivedProperties, d.id);
      if (dp !== undefined && dp.of !== of) throw new ExprError(p, `derived property ${d.id} is of ${dp.of}, not ${of}`);
      return derivedType(ont, d.id, p, stack, ctx.collect);
    }
    case "nav":
      throw new ExprError(p, "nav is valid only as the `in` of a quantifier");
    default:
      if (EXPR_NODES.includes(k as (typeof EXPR_NODES)[number])) throw new ExprError(p, `predicate ${k} in a value position`);
      throw new ExprError(p, `unknown expression node ${k}`);
  }
}

// A literal compared with `{ref: P}`, where P (no dot) is a parameter of the action that declares `values`, must be one of
// them. Quantifier variables cannot reuse parameter names, so such a ref is always the parameter.
function checkValues(ont: Stage1Ontology, e: unknown, xs: unknown[], ctx: ExprContext, p: string): void {
  if (ctx.action === undefined || !isObj(e) || typeof e.ref !== "string" || e.ref.includes(".")) return;
  const param = own(ont.actionTypes[ctx.action]?.parameters, e.ref);
  const vs = param?.values;
  if (param?.type !== "enum" || !Array.isArray(vs)) return;
  for (const x of xs) if (!vs.includes(x as string)) throw new ExprError(p, `literal ${JSON.stringify(x)} is not one of the values of parameter ${e.ref}`);
}

// Types the two operands of a binary operation; a literal takes the type of the other side.
function pair(ont: Stage1Ontology, a: unknown, b: unknown, ctx: ExprContext, p: string, stack: string[]): [Type, Type] {
  if (isLit(a) && isLit(b)) throw new ExprError(p, "both operands are literals");
  if (isLit(a)) {
    const tb = valueTypeIn(ont, b, ctx, undefined, `${p}[1]`, stack);
    return [valueTypeIn(ont, a, ctx, tb, `${p}[0]`, stack), tb];
  }
  const ta = valueTypeIn(ont, a, ctx, undefined, `${p}[0]`, stack);
  return [ta, valueTypeIn(ont, b, ctx, ta, `${p}[1]`, stack)];
}

function checkPredicateIn(ont: Stage1Ontology, e: unknown, ctx: ExprContext, at: string, stack: string[]): void {
  const k = nodeKey(e, at);
  const node = e as Record<string, unknown>;
  const p = `${at}.${k}`;
  if (COMPARE.has(k)) {
    const [a, b] = args(node, k, 2, p);
    const n0 = ctx.collect?.reads.length ?? 0;
    const [ta, tb] = pair(ont, a, b, ctx, p, stack);
    if (isSet(ta) || isSet(tb)) throw new ExprError(p, `${k} on a set; sets have only in and subsetOf`);
    // a property read compared by eq / neq with a string literal: record the literal with the read
    const [l, r] = isLit(a) ? [a, b] : [b, a];
    if ((k === "eq" || k === "neq") && ctx.collect?.reads.length === n0 + 1 && isLit(l) && typeof l.lit === "string" && isObj(r) && "ref" in r)
      ctx.collect.reads[n0].lit = l.lit;
    if (k === "eq" || k === "neq") {
      const idVsRef = (x: Type, y: Type) => x === "id" && typeof y !== "string" && "ref" in y;
      if (!typeEquals(ta, tb) && !idVsRef(ta, tb) && !idVsRef(tb, ta)) throw new ExprError(p, `${k} compares ${showType(ta)} with ${showType(tb)}`);
      if (isLit(l)) checkValues(ont, r, [l.lit], ctx, p);
    } else if (typeof ta !== "string" || !ORDERED.has(ta) || !typeEquals(ta, tb))
      throw new ExprError(p, `${k} needs two operands of one type among timestamp, date, duration, integer; found ${showType(ta)} and ${showType(tb)}`);
    return;
  }
  switch (k) {
    case "and":
    case "or":
      args(node, k, "2+", p).forEach((x, i) => checkPredicateIn(ont, x, ctx, `${p}[${i}]`, stack));
      return;
    case "not":
      checkPredicateIn(ont, args(node, k, 1, p)[0], ctx, `${p}[0]`, stack);
      return;
    case "in": {
      const [a, s] = args(node, k, 2, p);
      if (isLit(a) && isLit(s)) throw new ExprError(p, "both operands are literals");
      if (isLit(a)) {
        const ts = valueTypeIn(ont, s, ctx, undefined, `${p}[1]`, stack);
        if (!isSet(ts)) throw new ExprError(`${p}[1]`, `in needs a set, found ${showType(ts)}`);
        literal((a as { lit: unknown }).lit, ts.set, ctx, `${p}[0]`);
        return;
      }
      const ta = valueTypeIn(ont, a, ctx, undefined, `${p}[0]`, stack);
      if (isSet(ta)) throw new ExprError(`${p}[0]`, "in takes an element, found a set");
      const ts = valueTypeIn(ont, s, ctx, { set: ta }, `${p}[1]`, stack);
      if (!isSet(ts) || !typeEquals(ts.set, ta)) throw new ExprError(p, `in needs {set: ${showType(ta)}}, found ${showType(ts)}`);
      if (isLit(s) && Array.isArray(s.lit)) checkValues(ont, a, s.lit, ctx, p);
      return;
    }
    case "subsetOf": {
      const [a, b] = args(node, k, 2, p);
      const [ta, tb] = pair(ont, a, b, ctx, p, stack);
      if (!isSet(ta) || !typeEquals(ta, tb)) throw new ExprError(p, `subsetOf needs two sets of one element type, found ${showType(ta)} and ${showType(tb)}`);
      return;
    }
    case "isNull":
    case "isNotNull": {
      const [a] = args(node, k, 1, p);
      if (isLit(a)) throw new ExprError(`${p}[0]`, `${k} of a literal`);
      valueTypeIn(ont, a, ctx, undefined, `${p}[0]`, stack);
      return;
    }
    case "exists":
    case "none":
    case "all": {
      const q = node[k];
      if (!isObj(q) || typeof q.as !== "string") throw new ExprError(p, `${k} takes {as, in, where?}`);
      const as = q.as;
      if (RESERVED.has(as)) throw new ExprError(`${p}.as`, `${as} is a reserved name`);
      if (Object.hasOwn(ctx.locals, as)) throw new ExprError(`${p}.as`, `${as} is already bound by an outer quantifier`);
      if (ctx.action !== undefined && own(ont.actionTypes[ctx.action]?.parameters, as) !== undefined) throw new ExprError(`${p}.as`, `${as} is a parameter name`);
      const elem = navType(ont, q.in, ctx, `${p}.in`);
      if (q.where !== undefined) checkPredicateIn(ont, q.where, { ...ctx, locals: { ...ctx.locals, [as]: elem } }, `${p}.where`, stack);
      return;
    }
    default: {
      if (!VALUE_NODES.has(k)) throw new ExprError(p, `unknown predicate node ${k}`);
      // A value node of type boolean is a predicate: true / false / null give T / F / U.
      if (k === "lit") throw new ExprError(p, "a literal in a predicate position; there are no boolean literals");
      const t = valueTypeIn(ont, e, ctx, undefined, at, stack);
      if (t !== "boolean") throw new ExprError(p, `value ${k} of type ${showType(t)} in a predicate position; only a boolean value is a predicate`);
      return;
    }
  }
}

// Returns the element object type of a navigation.
export function navType(ont: Stage1Ontology, n: unknown, ctx: ExprContext, at: string): string {
  if (nodeKey(n, at) !== "nav") throw new ExprError(at, "a quantifier ranges over a nav");
  const v = (n as { nav: unknown }).nav;
  const p = `${at}.nav`;
  if (!isObj(v)) throw new ExprError(p, "nav takes {from, link, dir}");
  const from = bindingName(ont, v.from, ctx, `${p}.from`);
  const link = ont.linkTypes.find((l) => l.id === v.link);
  if (link === undefined) throw new ExprError(`${p}.link`, `link ${String(v.link)} is not declared`);
  if (v.dir === "forward") {
    if (from !== link.from) throw new ExprError(p, `forward ${link.id} starts at ${link.from}, not ${from}`);
    return link.to;
  }
  if (v.dir === "reverse") {
    if (from !== link.to) throw new ExprError(p, `reverse ${link.id} starts at ${link.to}, not ${from}`);
    return link.from;
  }
  throw new ExprError(`${p}.dir`, "dir is forward or reverse");
}

// Throws ExprError when expr is not a well-typed predicate in ctx.
export function checkPredicate(ont: Stage1Ontology, expr: unknown, ctx: ExprContext): void {
  if (ctx.action !== undefined)
    for (const name of Object.keys(ont.actionTypes[ctx.action]?.parameters ?? {}))
      if (RESERVED.has(name)) throw new ExprError("$", `parameter ${name} uses a reserved name`);
  checkPredicateIn(ont, expr, ctx, "$", []);
}

// Type-checks a derived property on its own and returns its declared type; throws ExprError when it is not well typed.
// With collect, its expression is the checked one (its literals are recorded).
export function derivedPropertyType(ont: Stage1Ontology, id: string, collect?: ExprReads): Type {
  return derivedType(ont, id, "$", [], collect, true);
}

// The type of a value expression; throws ExprError when it is not well typed. `expected` types a bare literal.
export function valueType(ont: Stage1Ontology, expr: unknown, ctx: ExprContext, expected?: Type): Type {
  return valueTypeIn(ont, expr, ctx, expected, "$", []);
}
