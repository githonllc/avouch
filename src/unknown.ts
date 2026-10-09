// Static UNKNOWN analysis (R12 unsafe_fallthrough, quantifier_absorbs_unknown): a sound, incomplete abstract evaluation.
// For every combination of null / non-null over the nullable reads of an expression, the concrete result (src/evaluate.ts)
// is in the abstract result. False positives are allowed; false negatives are not.
// Callers analyse only expressions that type-check. The evaluator throws NoExpression when it reaches a derived property
// without an expression (the absent-expression rule); absorbingQuantifiers skips such a quantifier body.
import type { SourceFacts } from "./contract.js";
import { navType, objectBinding, own, type Expr, type ExprContext, type Quantifier, type Stage1Ontology } from "./expr.js";

export const MAX_NULLABLE_REFS = 8;
export type Truth = "T" | "F" | "U";
// Whether a normalized path (`x` or `x.prop`) may be null.
export type MayNull = (path: string) => boolean;

class NoExpression extends Error {}
type Set3 = ReadonlySet<Truth>;
// One domain for values and predicates: a null value is {U}, a non-null value is {T, F}.
const U: Set3 = new Set(["U"]);
const TF: Set3 = new Set(["T", "F"]);
const QUANTIFIERS: ReadonlySet<string> = new Set(["exists", "none", "all"]);

const nodeKey = (e: Expr): string => Object.keys(e)[0];
const operands = (e: Expr): Expr[] => (e as unknown as Record<string, Expr[]>)[nodeKey(e)];
// `x.prop` -> ["x", "prop"]; `x` -> ["x", undefined]
function split(path: string): [string, string | undefined] {
  const dot = path.indexOf(".");
  return dot < 0 ? [path, undefined] : [path.slice(0, dot), path.slice(dot + 1)];
}
// A path with the head `self` replaced by the current self (an object binding name, or "self" at the root).
function norm(path: string, self: string): string {
  const [head, prop] = split(path);
  return head !== "self" ? path : prop === undefined ? self : `${self}.${prop}`;
}

const and3 = (a: Truth, b: Truth): Truth => (a === "F" || b === "F" ? "F" : a === "U" || b === "U" ? "U" : "T");
const or3 = (a: Truth, b: Truth): Truth => (a === "T" || b === "T" ? "T" : a === "U" || b === "U" ? "U" : "F");
const not3 = (a: Truth): Truth => (a === "T" ? "F" : a === "F" ? "T" : "U");
// a Kleene connective lifted to sets: the product of the operand sets
function lift(xs: Set3, ys: Set3, f: (a: Truth, b: Truth) => Truth): Set3 {
  const out = new Set<Truth>();
  for (const a of xs) for (const b of ys) out.add(f(a, b));
  return out;
}

// The abstract result of e for one combination: isNull says which normalized paths are null. Every operand of every node
// is evaluated (no short-circuit), and only isNull(of) of a derived property prunes: freeNullableRefs relies on both.
function ev(ont: Stage1Ontology, e: Expr, self: string, isNull: (path: string) => boolean): Set3 {
  const k = nodeKey(e);
  switch (k) {
    case "lit":
      return TF;
    case "ref":
      return isNull(norm((e as { ref: string }).ref, self)) ? U : TF;
    case "derived": {
      // the only place a derived property is inlined: null without reading the expression when its `of` is null
      const d = (e as { derived: { id: string; of: { ref: string } } }).derived;
      const of = norm(d.of.ref, self);
      if (isNull(of)) return U;
      const x = own(ont.derivedProperties, d.id)?.expr;
      if (x === undefined) throw new NoExpression(d.id);
      return ev(ont, x, of, isNull);
    }
    case "exists":
    case "none":
    case "all":
      return TF; // two-valued; the body is analysed on its own
    case "and":
    case "or": {
      const [first, ...rest] = operands(e).map((x) => ev(ont, x, self, isNull));
      return rest.reduce((acc, p) => lift(acc, p, k === "and" ? and3 : or3), first);
    }
    case "not":
      return new Set([...ev(ont, operands(e)[0], self, isNull)].map(not3));
    case "isNull":
    case "isNotNull": {
      const a = ev(ont, operands(e)[0], self, isNull);
      const out = new Set<Truth>();
      if (a.has("U")) out.add(k === "isNull" ? "T" : "F");
      if (a.has("T") || a.has("F")) out.add(k === "isNull" ? "F" : "T");
      return out;
    }
    default: {
      // strict nodes (comparisons, in, subsetOf, plus, dateIn): a null operand gives null; non-null operands give T or F
      // (no narrowing by constants)
      const xs = operands(e).map((x) => ev(ont, x, self, isNull));
      const out = new Set<Truth>();
      if (xs.some((x) => x.has("U"))) out.add("U");
      if (xs.every((x) => x.has("T") || x.has("F"))) (out.add("T"), out.add("F"));
      return out;
    }
  }
}

// The distinct normalized paths that may be null and that the outer evaluation reads, sorted. One run of ev with no path
// null reaches every read (ev evaluates every operand; only a null `of` prunes); quantifiers are not entered, and a
// `nav.from` is never a read.
export function freeNullableRefs(ont: Stage1Ontology, e: Expr, mayNull: MayNull): string[] {
  const seen = new Set<string>();
  ev(ont, e, "self", (p) => (seen.add(p), false));
  return [...seen].filter(mayNull).sort();
}

// The predicate results of e for one combination: isNull says which paths are null.
export function abstractEval(ont: Stage1Ontology, e: Expr, isNull: (path: string) => boolean): ReadonlySet<Truth> {
  return ev(ont, e, "self", isNull);
}

// Whether some combination of nulls over the free nullable reads of e may give U.
export function mayUnknown(ont: Stage1Ontology, e: Expr, mayNull: MayNull): boolean {
  const refs = freeNullableRefs(ont, e, mayNull);
  if (refs.length > MAX_NULLABLE_REFS) return true;
  for (let mask = 0; mask < 2 ** refs.length; mask++) {
    const nulls = new Set(refs.filter((_, i) => (mask >> i) & 1));
    if (abstractEval(ont, e, (p) => nulls.has(p)).has("U")) return true;
  }
  return false;
}

// Nullability for any context of one ontology and its facts; the field lists are read once per object type.
function nullability(ont: Stage1Ontology, facts: SourceFacts): (ctx: ExprContext) => MayNull {
  const lists = new Map<string, Map<string, { nullable: boolean }> | null>();
  const fields = (objectType: string) => {
    if (!lists.has(objectType)) {
      const doc = (own(ont.objectTypes, objectType) as { doc?: unknown } | undefined)?.doc;
      lists.set(objectType, typeof doc === "string" ? (facts.fieldList(doc, objectType)?.value ?? null) : null);
    }
    return lists.get(objectType)!;
  };
  return (ctx) => (path) => {
    const [head, prop] = split(path);
    if (head === "now" || head === "actor") return false;
    const local = head === "self" || Object.hasOwn(ctx.locals, head);
    const param = local || ctx.action === undefined ? undefined : own(ont.actionTypes[ctx.action]?.parameters, head);
    if (!local && param === undefined) return true; // not reachable after the type check; conservative
    if (param?.optional === true) return true; // an optional parameter, and every property read through it
    if (prop === undefined) return false; // an object binding, or a required parameter
    const o = objectBinding(ont, head, ctx);
    return o === undefined || fields(o)?.get(prop)?.nullable !== false; // non-null only when the field list says so
  };
}

// Nullability of the paths in ctx. A field is non-null only when its field list says so; a field that is not listed,
// or an object without a field list, has unknown nullability and may be null. An optional parameter may be null; so
// may every property read through it.
export function mayNullIn(ont: Stage1Ontology, facts: SourceFacts, ctx: ExprContext): MayNull {
  return nullability(ont, facts)(ctx);
}

// The quantifiers of e (preorder, through and / or / not and quantifier bodies) whose body may be UNKNOWN. Paths use
// the type-error notation: `$.none`, `$.and[1].none`, `$.all.where.and[0].exists`. Derived property nodes are not
// entered: a quantifier inside a derived property is reported once, for the derived property itself. A body that
// reaches a derived property without an expression is not analysed (its nested quantifiers still are).
export function absorbingQuantifiers(ont: Stage1Ontology, facts: SourceFacts, e: Expr, ctx: ExprContext): string[] {
  const out: string[] = [];
  const mayNullFor = nullability(ont, facts);
  const walk = (x: Expr, at: string, c: ExprContext): void => {
    const k = nodeKey(x);
    const p = `${at}.${k}`;
    if (k === "and" || k === "or" || k === "not") operands(x).forEach((y, i) => walk(y, `${p}[${i}]`, c));
    else if (QUANTIFIERS.has(k)) {
      const q = (x as unknown as Record<string, Quantifier>)[k];
      if (q.where === undefined) return;
      const c2: ExprContext = { ...c, locals: { ...c.locals, [q.as]: navType(ont, q.in, c, `${p}.in`) } };
      try {
        if (mayUnknown(ont, q.where, mayNullFor(c2))) out.push(p);
      } catch (err) {
        if (!(err instanceof NoExpression)) throw err;
      }
      walk(q.where, `${p}.where`, c2);
    }
  };
  walk(e, "$", ctx);
  return out;
}
