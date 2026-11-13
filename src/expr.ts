// Decision expressions: the AST, the semantic types, the part of an ontology the evaluator reads, and the static type check.
// No imports. The evaluator (./evaluate) assumes every expression it runs has passed checkPredicate / valueType.

export type Scalar = "enum" | "timestamp" | "duration" | "date" | "timezone" | "id" | "integer" | "number" | "boolean" | "string" | { ref: string };
// A value of type "string" is read only by isNull / isNotNull; as a set element (actor.keys) it has in and subsetOf.
// A record type is valid only in a parameter type (the schema keeps it out of properties and derived properties). A field
// is required unless `optional` names it. A record has no operations: an expression reads its fields.
export type RecordType = { record: Record<string, Type>; optional?: string[] };
export type Type = Scalar | { set: Scalar } | RecordType | { set: RecordType };

export const SCALAR_TYPE_NAMES = ["enum", "timestamp", "duration", "date", "timezone", "id", "integer", "number", "boolean", "string"] as const;
export const EXPR_NODES = [
  "ref", "lit", "plus", "dateIn", "derived",
  "eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not", "in", "subsetOf", "isNull", "isNotNull",
  "exists", "none", "all", "nav",
] as const;

export type Lit = string | number | (string | number)[];
// Navigation appears only as the `in` of a quantifier.
export type Nav = { nav: { from: { ref: string }; link: string; dir: "forward" | "reverse" } };
// The `in` of a quantifier: a navigation, or a {ref} path of a set type that reads no property of an object.
export type Quantifier = { as: string; in: Nav | { ref: string }; where?: Expr };
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
// Every invocation-layer result, SCOPE_DENIED included. SCOPE_DENIED is internal and never reported (SPEC section 9).
export const INVOCATION_RESULTS = ["REPLAYED", "IDEMPOTENCY_CONFLICT", "INVALID_BINDING", "SCOPE_DENIED", "PERMISSION_DENIED"] as const;
// principals: the actor kinds the form admits; its cite is ignored by evaluation.
export type Principals = { kinds: string[]; cite?: unknown };
export type Alt = { keys: string[]; conditional_keys?: string[]; conditional_when?: Expr; principals?: Principals };
export type Permission = "unknown" | { none: string; principals?: Principals } | Alt | { any_of: Alt[] };
export type DecisionRow = { when: { passes: string } | { fails: string }; result: string; next?: unknown };
export type Decision = { hitPolicy: "first"; rows: DecisionRow[]; otherwise?: { result: string; next?: unknown } };
export type Condition = { id: string; expr?: Expr; unspecified?: string };
export type ActionType = {
  parameters?: Record<string, { type?: Type; optional?: true; values?: string[]; projectedFrom?: string[]; unresolved?: "domain" }>;
  permission: Permission;
  conditions: Condition[];
  decision?: Decision;
};
// The distinct request fields of a projected parameter, or null: only a scalar {ref: T} parameter with at least one field is
// projected; on any other parameter projectedFrom has no effect.
export function projectedFields(p: { type?: unknown; projectedFrom?: unknown }): string[] | null {
  const fs = Array.isArray(p.projectedFrom) ? [...new Set(p.projectedFrom.filter((f): f is string => typeof f === "string"))] : [];
  return isObj(p.type) && typeof p.type.ref === "string" && fs.length > 0 ? fs : null;
}
// Whether an id of p that does not resolve binds to null (`unresolved: domain`): only on a required scalar {ref: T}
// parameter (no optional key) without projectedFrom. On any other parameter the key has no effect, and R1 reports it.
export function resolvesInDomain(p: { type?: unknown; optional?: unknown; projectedFrom?: unknown; unresolved?: unknown }): boolean {
  return p.unresolved === "domain" && isObj(p.type) && typeof p.type.ref === "string" && !("set" in p.type) && p.optional === undefined && p.projectedFrom === undefined;
}

// Only the keys evaluation reads; other keys (cite, cites, ...) may be present and are ignored.
export interface Stage1Ontology {
  scope?: { by: string; global?: { type: string }[]; root?: { type: string } };
  dispositions?: Record<string, { class: DispositionClass }>;
  objectTypes: Record<string, { datasource: string; properties: Record<string, { type?: Type; from?: { field: string; key: string } }> }>;
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
// locals: quantifier variable -> object type. values: quantifier variable -> its type, for a variable that is not an
// object binding (an element of a set of records or of a set of scalars). collect: optional record of what the check
// reads; nested: inside a reached derived expression (its literals are not the checked expression's own).
export type ExprContext = { action?: string; self?: string; locals: Record<string, string>; values?: Record<string, Type>; collect?: ExprReads; nested?: boolean };

const VALUE_NODES = new Set(["ref", "lit", "plus", "dateIn", "derived"]);
const COMPARE = new Set(["eq", "neq", "lt", "lte", "gt", "gte"]);
const ORDERED = new Set(["timestamp", "date", "duration", "integer", "number"]);
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
  typeof t === "string"
    ? t
    : "ref" in t
      ? `{ref: ${t.ref}}`
      : "set" in t
        ? `{set: ${showType(t.set)}}`
        : `{record: {${Object.entries(t.record).map(([f, ft]) => `${f}: ${showType(ft)}`).join(", ")}}${Array.isArray(t.optional) ? `, optional: [${t.optional.join(", ")}]` : ""}}`;

const isSet = (t: Type): t is { set: Scalar } | { set: RecordType } => typeof t !== "string" && "set" in t;
export const isRecordType = (t: Type | undefined): t is RecordType => t !== undefined && typeof t !== "string" && "record" in t;
// A record or a set of records: a type that has no operations.
export const hasRecord = (t: Type): boolean => isRecordType(t) || (isSet(t) && isRecordType(t.set));

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
  return misfit(v, t, "") === null;
}

// The place of the first value that does not fit, or null when v fits t. at names v; a set element is `<at>[<i>]` and a
// record field `<at>.<field>`, in array order and declared field order. A required field that is absent or null does
// not fit; an optional one reads as null; a field the type does not declare is ignored; a set element is never null.
export function misfit(v: unknown, t: Type | "string", at: string): string | null {
  if (typeof t !== "string") {
    if ("set" in t) {
      if (!Array.isArray(v)) return at;
      for (const [i, x] of v.entries()) {
        const m = misfit(x, t.set, `${at}[${i}]`);
        if (m !== null) return m;
      }
      return null;
    }
    if ("record" in t) {
      if (!isObj(v)) return at;
      const optional = Array.isArray(t.optional) ? t.optional : [];
      for (const [f, ft] of Object.entries(t.record)) {
        const x = own(v, f);
        const m = x === undefined || x === null ? (optional.includes(f) ? null : `${at}.${f}`) : misfit(x, ft, `${at}.${f}`);
        if (m !== null) return m;
      }
      return null;
    }
    return typeof v === "string" && v !== "" ? null : at;
  }
  return scalarFits(v, t) ? null : at;
}

function scalarFits(v: unknown, t: Exclude<Scalar, { ref: string }> | "string"): boolean {
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
    case "number":
      return typeof v === "number" && Number.isFinite(v);
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

// A path: a head (now, actor, self, a parameter or a quantifier variable), then record fields, then at most one property
// of an object. Each segment is read by the type before it: a record gives a field, a ref gives a property of the bound
// object. domain: the path of a quantifier domain, which reads no property of an object.
function refType(ont: Stage1Ontology, path: string, ctx: ExprContext, at: string, domain = false): Type {
  const parts = path.split(".");
  if (parts.some((p) => p === "")) throw new ExprError(at, `ref ${path}: an empty segment`);
  const [head, ...rest] = parts;
  if (head === "now" || head === "actor") {
    if (rest.length > 1) throw new ExprError(at, `ref ${path}: at most one dot`);
    const prop = rest[0];
    if (head === "now") {
      if (prop !== undefined) throw new ExprError(at, "now has no properties");
      return "timestamp";
    }
    if (prop === "id") return "id";
    if (prop === "keys") return { set: "string" };
    if (prop === "kind") return "enum";
    throw new ExprError(at, `actor.${prop ?? ""} is not readable; use actor.id, actor.keys or actor.kind`);
  }
  if (head === "self" && ctx.self === undefined) throw new ExprError(at, "self is valid only in a derived property expression");
  let t: Type;
  const value = ctx.values !== undefined && Object.hasOwn(ctx.values, head) ? ctx.values[head] : undefined;
  const obj = value === undefined ? objectBinding(ont, head, ctx) : undefined;
  if (obj !== undefined && own(ont.objectTypes, obj) === undefined) throw new ExprError(at, `object type ${obj} is not declared`);
  if (value !== undefined) t = value;
  else if (obj !== undefined) t = { ref: obj };
  else {
    if (ctx.action === undefined) throw new ExprError(at, `${head} is not visible here`);
    const p = own(ont.actionTypes[ctx.action]?.parameters, head);
    if (p === undefined) throw new ExprError(at, `${head} is not a parameter, a binding or a reserved name`);
    if (p.type === undefined) throw new ExprError(at, `parameter ${head} has no type`);
    t = p.type;
  }
  for (const [i, seg] of rest.entries()) {
    const before = parts.slice(0, i + 1).join(".");
    if (isRecordType(t)) {
      const ft = own(t.record, seg);
      if (ft === undefined) throw new ExprError(at, `${seg} is not a field of the record ${before}`);
      t = ft;
      continue;
    }
    if (typeof t === "string" || !("ref" in t)) throw new ExprError(at, i === 0 ? `${head} is not an object binding` : `${before} is not a record or an object binding`);
    if (i !== rest.length - 1) throw new ExprError(at, `ref ${path}: at most one dot after an object binding; a path reads at most one property of an object`);
    if (domain) throw new ExprError(at, `ref ${path}: a quantifier domain reads no property of an object`);
    const o = t.ref;
    if (own(ont.objectTypes, o) === undefined) throw new ExprError(at, `object type ${o} is not declared`);
    if (own(ont.derivedProperties, seg)?.of === o) throw new ExprError(at, `${seg} is a derived property; read it with {derived: {id, of}}`);
    const pt = own(ont.objectTypes[o].properties, seg)?.type;
    if (pt === undefined) throw new ExprError(at, `${o}.${seg} is not a declared property with a type`);
    ctx.collect?.reads.push({ prop: `${o}.${seg}` });
    return pt;
  }
  return t;
}

// What a quantifier variable is: an object binding of an object type, or a value of a type (a record or a scalar).
export type DomainVar = { object: string } | { value: Type };
// The `in` of a quantifier: a navigation, or a {ref} path of type {set: E} whose head is a parameter or a quantifier
// variable and which reads no property of an object. A ref element gives an object binding; another element a value.
export function quantifierDomain(ont: Stage1Ontology, n: unknown, ctx: ExprContext, at: string): DomainVar {
  if (nodeKey(n, at) !== "ref") return { object: navType(ont, n, ctx, at) };
  const path = (n as { ref: unknown }).ref;
  const p = `${at}.ref`;
  if (typeof path !== "string") throw new ExprError(p, "ref takes a path string");
  const head = path.split(".")[0];
  if (RESERVED.has(head)) throw new ExprError(p, `${path}: a quantifier domain is a parameter or a field of a record, not ${head}`);
  const t = refType(ont, path, ctx, p, true);
  if (!isSet(t)) throw new ExprError(p, `a quantifier ranges over a nav or a set, found ${showType(t)}`);
  const e = t.set;
  if (typeof e === "string" || !("ref" in e)) return { value: e };
  if (own(ont.objectTypes, e.ref) === undefined) throw new ExprError(p, `object type ${e.ref} is not declared`);
  return { object: e.ref };
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
      if (expected === "string") throw new ExprError(p, "there are no string literals; a string is read only by isNull and isNotNull");
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
    if (hasRecord(ta) || hasRecord(tb)) throw new ExprError(p, `${k} on a record; a record has no operations, read one of its fields`);
    if (isSet(ta) || isSet(tb)) throw new ExprError(p, `${k} on a set; sets have only in and subsetOf`);
    if (ta === "string" || tb === "string") throw new ExprError(p, `${k} on a string; a string is read only by isNull and isNotNull`);
    // a property read compared by eq / neq with a string literal: record the literal with the read
    const [l, r] = isLit(a) ? [a, b] : [b, a];
    if ((k === "eq" || k === "neq") && ctx.collect?.reads.length === n0 + 1 && isLit(l) && typeof l.lit === "string" && isObj(r) && "ref" in r)
      ctx.collect.reads[n0].lit = l.lit;
    if (k === "eq" || k === "neq") {
      const idVsRef = (x: Type, y: Type) => x === "id" && typeof y !== "string" && "ref" in y;
      if (!typeEquals(ta, tb) && !idVsRef(ta, tb) && !idVsRef(tb, ta)) throw new ExprError(p, `${k} compares ${showType(ta)} with ${showType(tb)}`);
      if (isLit(l)) checkValues(ont, r, [l.lit], ctx, p);
    } else if (typeof ta !== "string" || !ORDERED.has(ta) || !typeEquals(ta, tb))
      throw new ExprError(p, `${k} needs two operands of one type among timestamp, date, duration, integer, number; found ${showType(ta)} and ${showType(tb)}`);
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
        if (!isSet(ts) || hasRecord(ts)) throw new ExprError(`${p}[1]`, `in needs a set of a scalar type, found ${showType(ts)}`);
        literal((a as { lit: unknown }).lit, ts.set, ctx, `${p}[0]`);
        return;
      }
      const ta = valueTypeIn(ont, a, ctx, undefined, `${p}[0]`, stack);
      if (hasRecord(ta)) throw new ExprError(`${p}[0]`, "in on a record; a record has no operations, read one of its fields");
      if (isSet(ta)) throw new ExprError(`${p}[0]`, "in takes an element, found a set");
      if (ta === "string") throw new ExprError(`${p}[0]`, "in on a string; a string is read only by isNull and isNotNull");
      const ts = valueTypeIn(ont, s, ctx, { set: ta as Scalar }, `${p}[1]`, stack);
      if (!isSet(ts) || !typeEquals(ts.set, ta)) throw new ExprError(p, `in needs {set: ${showType(ta)}}, found ${showType(ts)}`);
      if (isLit(s) && Array.isArray(s.lit)) checkValues(ont, a, s.lit, ctx, p);
      return;
    }
    case "subsetOf": {
      const [a, b] = args(node, k, 2, p);
      const [ta, tb] = pair(ont, a, b, ctx, p, stack);
      if (hasRecord(ta) || hasRecord(tb)) throw new ExprError(p, "subsetOf on a set of records; a record has no operations");
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
      if (Object.hasOwn(ctx.locals, as) || (ctx.values !== undefined && Object.hasOwn(ctx.values, as))) throw new ExprError(`${p}.as`, `${as} is already bound by an outer quantifier`);
      if (ctx.action !== undefined && own(ont.actionTypes[ctx.action]?.parameters, as) !== undefined) throw new ExprError(`${p}.as`, `${as} is a parameter name`);
      const v = quantifierDomain(ont, q.in, ctx, `${p}.in`);
      if (q.where !== undefined) checkPredicateIn(ont, q.where, bindVariable(ctx, as, v), `${p}.where`, stack);
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

// A pure link: its table is no object's datasource (the evaluator reads snapshot.links[link.id]).
export function isPureLink(ont: Stage1Ontology, link: Stage1Ontology["linkTypes"][number]): boolean {
  return link.table !== undefined && !(isObj(ont.objectTypes) && Object.values(ont.objectTypes).some((o) => isObj(o) && o.datasource === link.table));
}
// A navigation over a foreign-key link reads link.via on rows of link.from (forward: the source row; reverse: each target
// row). Recorded only when via is a declared property of link.from and neither name has a dot (a read is `<Object>.<prop>`).
function collectVia(ont: Stage1Ontology, link: Stage1Ontology["linkTypes"][number], ctx: ExprContext): void {
  if (ctx.collect === undefined || isPureLink(ont, link) || typeof link.via !== "string" || link.via.includes(".") || String(link.from).includes(".") || !isObj(ont.objectTypes)) return;
  const props = own(ont.objectTypes, link.from)?.properties;
  if (isObj(props) && own(props, link.via) !== undefined) ctx.collect.reads.push({ prop: `${link.from}.${link.via}` });
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
    collectVia(ont, link, ctx);
    return link.to;
  }
  if (v.dir === "reverse") {
    if (from !== link.to) throw new ExprError(p, `reverse ${link.id} starts at ${link.to}, not ${from}`);
    collectVia(ont, link, ctx);
    return link.from;
  }
  throw new ExprError(`${p}.dir`, "dir is forward or reverse");
}

// ctx with the quantifier variable `as` added.
export function bindVariable(ctx: ExprContext, as: string, v: DomainVar): ExprContext {
  return "object" in v ? { ...ctx, locals: { ...ctx.locals, [as]: v.object } } : { ...ctx, values: { ...ctx.values, [as]: v.value } };
}

// Throws ExprError when expr is not a well-typed predicate in ctx.
export function checkPredicate(ont: Stage1Ontology, expr: unknown, ctx: ExprContext): void {
  if (ctx.action !== undefined)
    for (const name of Object.keys(ont.actionTypes[ctx.action]?.parameters ?? {}))
      if (RESERVED.has(name)) throw new ExprError("$", `parameter ${name} uses a reserved name`);
  checkPredicateIn(ont, expr, ctx, "$", []);
}

// A permission conditional_when: a predicate over request inputs only. The permission step runs after shape and before
// binding and reads no snapshot, so only these nodes are allowed, a ref is actor.<x> or a parameter name without a dot,
// and a projected parameter (not a request field) is not readable. Then the ordinary type check.
const WHEN_NODES = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not", "in", "subsetOf", "isNull", "isNotNull", "ref", "lit"]);
export function checkPermissionWhen(ont: Stage1Ontology, expr: unknown, action: string, collect?: ExprReads): void {
  const walk = (e: unknown, at: string): void => {
    const k = nodeKey(e, at);
    const p = `${at}.${k}`;
    if (!WHEN_NODES.has(k)) throw new ExprError(p, `${k} is not allowed in conditional_when; it reads only parameters, actor and literals`);
    if (k === "lit") return;
    const v = (e as Record<string, unknown>)[k];
    if (k === "ref") {
      if (typeof v !== "string") return; // the type check reports it
      const [head, prop] = v.split(".");
      if (head === "actor") return; // the type check checks the property
      if (head === "now") throw new ExprError(p, "now is not allowed in conditional_when");
      if (prop !== undefined) throw new ExprError(p, `${v}: conditional_when reads no property; it reads a parameter as given`);
      const param = own(ont.actionTypes[action]?.parameters, head);
      if (param !== undefined && projectedFields(param) !== null) throw new ExprError(p, `${head} is a projected parameter; conditional_when reads only request inputs`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
  };
  walk(expr, "$");
  checkPredicate(ont, expr, { action, locals: {}, collect });
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
