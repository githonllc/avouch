// Read-only queries over an ontology: what an action requires and decides, who writes or reads a property, which claims
// cite an anchor. Pure functions: they never throw on any parsed YAML, and they return plain JSON (no Map, no Set).
// Every result field is an ontology value or a mechanical projection of one; a missing or ill-typed value is null ([] for
// a list). The read sets come from the type check (checkPredicate / derivedPropertyType with collect), as for R4.
import { checkPredicate, derivedPropertyType, isObj, newReads, own, type Expr, type Stage1Ontology, type Type } from "./expr.js";

export type S = string | null;
export type QueryCite = { doc: string; quote: string };
export type QueryStamp = { ontology: string; /* absolute realpath */ git: { commit: string; dirty: boolean; path: string /* relative to the repository root, "/" separated */ } | null;
  check: { status: "not_run" } | { status: "pass" | "fail"; adapter: string; schemaErrors: number; violations: number; waived: number } };
export type QueryVerb = "list" | "action" | "object" | "result" | "writes" | "reads" | "cites";
export type QueryEnvelope = { avouchQuery: 1; stamp: QueryStamp; verb: QueryVerb; arg: string; result: unknown /* one of the types below, or null */ };
export type QueryList =
  | { kind: "actions"; items: { id: string; context: S; doc: S; docTerm: S; permissionKeys: string[] }[] }
  | { kind: "objects"; items: { id: string; context: S; datasource: S; outOfScope: S }[] }
  | { kind: "links"; items: { id: string; from: S; to: S; cardinality: S; via: S; table: S }[] }
  | { kind: "derived"; items: { id: string; of: S; type: Type | null; docTerm: S; hasExpr: boolean }[] }
  | { kind: "dispositions"; items: { id: string; class: S; cite: QueryCite | null }[] }
  | { kind: "anchors"; items: { doc: string; claims: number }[] }
  | { kind: "gaps"; items: { id: S; rule: S; kind: S; keys: string[]; conflict: S; proposed: S }[] };
export type QueryAlt = { keys: string[]; conditionalKeys: string[]; cite: QueryCite | null; conditionalCite: QueryCite | null;
  principals: { kinds: string[]; cite: QueryCite | null } | null };
export type QueryRow = { row: number | "otherwise"; when: { passes: string } | { fails: string } | null; result: S; class: S;
  cites: QueryCite[]; next: unknown /* the raw value, or null */; requires: { condition: string; must: "pass" | "fail"; specified: boolean }[];
  blockedBy: S /* the first condition with specified=false in an earlier row (static): decide stops at that row for an input where that condition is
    undefined (always for an unspecified condition; for a derived property without expr only when evaluation reaches it) */ };
export type QueryAction = { id: string; context: S; doc: S; docTerm: S;
  permission: { form: "unknown" } | { form: "none"; reason: S; cite: QueryCite | null; principals: QueryAlt["principals"] } | { form: "keys"; alternatives: QueryAlt[] };
  idempotencyKey: { required: boolean; cite: QueryCite | null } | null;
  parameters: { name: string; type: Type | null; optional: boolean; values: string[] | null; cite: QueryCite | null }[];
  conditions: { id: string; expr: Expr | null; exprText: S; unspecified: S; reads: unknown[]; cites: QueryCite[]; scenarios: string[] }[];
  decision: { order: QueryCite | null; rows: QueryRow[] /* otherwise, when present, is last */ } | null;
  edits: { prop: string; cite: QueryCite | null /* edit_cites */ }[]; creates: string[]; emits: string[];
  linkEffects: { link: string; kind: "effect" | "none" | "unspecified"; text: S; cite: QueryCite | null; scenarios: string[] }[];
  crossContext: { via: S; unspecified: S; cite: QueryCite | null } | null; evidence: S;
  transitions: { object: string; from: S; to: S }[] /* state machine transitions whose by names this action */ };
export type QueryObject = { id: string; context: S; datasource: S; doc: S; outOfScope: S; scope: "tenant" | "global" | "root" | null;
  properties: { name: string; class: S; type: Type | null; cite: QueryCite | null; canonicalValues: { values: string[]; cite: QueryCite | null } | null;
    materializedFrom: { reads: string[]; cites: QueryCite[] } | null }[];
  derived: { id: string; type: Type | null; docTerm: S; exprText: S; cite: QueryCite | null }[];
  stateMachine: { doc: S; initial: S; terminal: string[]; transitions: { from: S; to: S; by: string[]; outOfScope: S }[] } | null;
  links: { id: string; end: "from" | "to"; other: S; cardinality: S; via: S }[];
  writers: { action: string; edits: string[]; creates: boolean }[]; readers: { action: string; condition: string; props: string[] }[];
  unanalyzed: QueryWrites["unanalyzed"] /* conditions ("<action>:<condition>") and derived properties that do not type-check */ };
export type QueryDisposition = { disposition: string; class: S; cite: QueryCite | null; rows: ({ action: string } & QueryRow)[] };
export type QueryWrites = { target: string; kind: "property" | "derived"; unanalyzed: { at: string; error: string }[];
  writers: { action: string; cite: QueryCite | null; path: string[] /* [] = direct */ }[]; creators: string[] };
export type QueryReads = { target: string; kind: "property" | "derived"; materialized: string[]; unanalyzed: { at: string; error: string }[];
  conditions: { action: string; condition: string; source: "expr" | "reads"; direct: boolean; via: string[]; rows: number[] }[];
  derived: { id: string; source: "expr" | "reads"; direct: boolean; via: string[] }[] };
export type QueryCites = { anchor: string; claims: { path: string; subject: string; quote: S }[] };

type Any = Record<string, any>;
const str = (x: unknown): S => (typeof x === "string" ? x : null);
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const strs = (x: unknown): string[] => arr(x).filter((y): y is string => typeof y === "string");
const map = (x: unknown): Any => (isObj(x) ? x : {});
const ownObj = (r: Any, k: string): Any | undefined => {
  const v = own(r, k);
  return isObj(v) ? v : undefined;
};
const typeOf = (x: unknown): Type | null => (typeof x === "string" || isObj(x) ? (x as Type) : null);
const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(sortStr);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function citeOf(x: unknown): QueryCite | null {
  return isObj(x) && typeof x.doc === "string" && typeof x.quote === "string" ? { doc: x.doc, quote: x.quote } : null;
}
// A cites list: [{cite: {doc, quote}}, ...]; entries without a valid cite are left out.
const citesOf = (x: unknown): QueryCite[] => arr(x).flatMap((y) => (isObj(y) && citeOf(y.cite) ? [citeOf(y.cite)!] : []));

const root = (ont: unknown): Any => map(ont);
const actions = (ont: unknown) => map(root(ont).actionTypes);
const objects = (ont: unknown) => map(root(ont).objectTypes);
const deriveds = (ont: unknown) => map(root(ont).derivedProperties);

// ---------------------------------------------------------------------------------------------------------- showExpr

const COMPARE: Record<string, string> = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function unknownNode(e: unknown): string {
  try {
    return `<?>${JSON.stringify(e)}`;
  } catch {
    return "<?>";
  }
}

function showLit(v: unknown): string | null {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return `[${v.map((x) => showLit(x)).join(", ")}]`;
  return null;
}

// Renders an expression as one line of text. Never throws.
export function showExpr(e: unknown): string {
  return show(e, true);
}

function show(e: unknown, atRoot: boolean): string {
  if (!isObj(e) || Object.keys(e).length !== 1) return unknownNode(e);
  const [k] = Object.keys(e);
  const v = e[k];
  const two = Array.isArray(v) && v.length === 2;
  const one = Array.isArray(v) && v.length === 1;
  const wrap = (s: string) => (atRoot ? s : `(${s})`);
  if (k === "ref" && typeof v === "string") return v;
  if (k === "lit") return showLit(v) ?? unknownNode(e);
  if (COMPARE[k] !== undefined && two) return `${show(v[0], false)} ${COMPARE[k]} ${show(v[1], false)}`;
  if (k === "plus" && two) return `${show(v[0], false)} + ${show(v[1], false)}`;
  if (k === "dateIn" && two) return `dateIn(${show(v[0], true)}, ${show(v[1], true)})`;
  if (k === "derived" && isObj(v) && typeof v.id === "string" && isObj(v.of) && typeof v.of.ref === "string") return `${v.id}(${v.of.ref})`;
  if ((k === "and" || k === "or") && Array.isArray(v) && v.length > 0) return wrap(v.map((x) => show(x, false)).join(` ${k} `));
  if (k === "not" && one) return `not(${show(v[0], true)})`;
  if (k === "in" && two) return `${show(v[0], false)} in ${show(v[1], false)}`;
  if (k === "subsetOf" && two) return `${show(v[0], false)} subsetOf ${show(v[1], false)}`;
  if (k === "isNull" && one) return `${show(v[0], false)} is null`;
  if (k === "isNotNull" && one) return `${show(v[0], false)} is not null`;
  if ((k === "exists" || k === "none" || k === "all") && isObj(v) && typeof v.as === "string" && isObj(v.in) && isObj(v.in.nav)) {
    const n = v.in.nav;
    if (!isObj(n.from) || typeof n.from.ref !== "string" || typeof n.link !== "string" || typeof n.dir !== "string") return unknownNode(e);
    const where = v.where !== undefined ? ` where ${show(v.where, false)}` : "";
    return wrap(`${k} ${v.as} in ${n.from.ref}.${n.link}(${n.dir})${where}`);
  }
  return unknownNode(e);
}

// ---------------------------------------------------------------------------------------------------------- read sets

// The view that the type check reads; non-mappings become empty so that it cannot fail on shape.
function view(ont: unknown): Stage1Ontology {
  const r = root(ont);
  const objs: Any = {};
  for (const [k, o] of Object.entries(objects(ont))) objs[k] = { ...map(o), properties: map(map(o).properties) };
  const params = (a: Any) => (isObj(a.parameters) ? a.parameters : {});
  const acts: Any = {};
  for (const [k, a] of Object.entries(actions(ont))) acts[k] = { ...map(a), parameters: params(map(a)) };
  return {
    scope: isObj(r.scope) ? r.scope : undefined,
    dispositions: map(r.dispositions),
    objectTypes: objs,
    linkTypes: arr(r.linkTypes).filter(isObj) as Stage1Ontology["linkTypes"],
    derivedProperties: { ...deriveds(ont) },
    actionTypes: acts,
  } as Stage1Ontology;
}

// The view with the expression of every derived property removed, except `keep`: a type check on it records only the
// first hop (the properties read directly, and the derived properties referenced directly).
function stripped(v: Stage1Ontology, keep?: string): Stage1Ontology {
  const d: Any = {};
  for (const [k, x] of Object.entries(v.derivedProperties ?? {})) {
    if (!isObj(x) || k === keep) d[k] = x;
    else {
      const { expr: _expr, ...rest } = x as Any;
      d[k] = rest;
    }
  }
  return { ...v, derivedProperties: d };
}

type Inputs = { props: string[]; derived: string[]; error?: string };

// A read string: "<Object>.<prop>", or a derived property named bare or as "<of>.<id>".
function classify(ont: unknown, s: string): { derived: string } | { prop: string } {
  const d = deriveds(ont);
  if (!s.includes(".") && own(d, s) !== undefined) return { derived: s };
  const [o, p] = s.split(".");
  if (p !== undefined && ownObj(map(ownObj(objects(ont), o)?.properties), p) === undefined && ownObj(d, p)?.of === o) return { derived: p };
  return { prop: s };
}

function readsListInputs(ont: unknown, reads: unknown): Inputs {
  const props: string[] = [], derived: string[] = [];
  for (const r of arr(reads)) {
    if (typeof r === "string") {
      const c = classify(ont, r);
      if ("derived" in c) derived.push(c.derived);
      else props.push(c.prop);
    } else if (isObj(r) && typeof r.prop === "string") props.push(r.prop);
  }
  return { props: uniqSorted(props), derived: uniqSorted(derived) };
}

// One analysis per ontology value: derived inputs, condition inputs, closures, and specified flags.
class Analysis {
  private readonly v: Stage1Ontology;
  private readonly dInputs = new Map<string, Inputs>();
  private readonly closures = new Map<string, { props: Set<string>; derived: Set<string> }>();
  constructor(readonly ont: unknown) {
    this.v = view(ont);
  }

  derivedInputs(id: string): Inputs {
    let r = this.dInputs.get(id);
    if (r !== undefined) return r;
    const dp = ownObj(deriveds(this.ont), id);
    if (dp === undefined) r = { props: [], derived: [] };
    else if (dp.expr === undefined) r = readsListInputs(this.ont, dp.reads);
    else {
      const collect = newReads();
      try {
        derivedPropertyType(stripped(this.v, id), id, collect);
        r = { props: uniqSorted(collect.reads.map((x) => x.prop)), derived: uniqSorted([...collect.undefinedDerived]) };
      } catch (e) {
        r = { props: [], derived: [], error: errText(e) };
      }
      // The full view also follows the chain, so a cycle of derived properties is an error here.
      if (r.error === undefined)
        try {
          derivedPropertyType(this.v, id);
        } catch (e) {
          r = { ...r, error: errText(e) };
        }
    }
    this.dInputs.set(id, r);
    return r;
  }

  // Everything a derived property reads, through any chain of derived properties (cycles stop).
  closure(id: string): { props: Set<string>; derived: Set<string> } {
    const c = this.closures.get(id);
    if (c !== undefined) return c;
    const props = new Set<string>(), derived = new Set<string>();
    const stack = [id], seen = new Set<string>([id]);
    while (stack.length) {
      const inp = this.derivedInputs(stack.pop()!);
      for (const p of inp.props) props.add(p);
      for (const d of inp.derived) {
        derived.add(d);
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      }
    }
    const r = { props, derived };
    this.closures.set(id, r);
    return r;
  }

  conditionInputs(action: string, cond: Any): Inputs & { source: "expr" | "reads" } {
    if (cond.expr === undefined) return { ...readsListInputs(this.ont, cond.reads), source: "reads" };
    const collect = newReads();
    try {
      checkPredicate(stripped(this.v), cond.expr, { action, locals: {}, collect });
      return { props: uniqSorted(collect.reads.map((x) => x.prop)), derived: uniqSorted([...collect.undefinedDerived]), source: "expr" };
    } catch (e) {
      return { props: [], derived: [], error: errText(e), source: "expr" };
    }
  }

  // A condition is specified when it has an expression that type-checks and reaches no derived property without one.
  specified(action: string, cond: Any | undefined): boolean {
    if (cond === undefined || cond.expr === undefined) return false;
    const collect = newReads();
    try {
      checkPredicate(this.v, cond.expr, { action, locals: {}, collect });
    } catch {
      return false;
    }
    return collect.undefinedDerived.size === 0;
  }
}

const conditionsOf = (a: Any): Any[] => arr(a.conditions).filter((c) => isObj(c) && typeof c.id === "string");
const sortedActions = (ont: unknown): [string, Any][] =>
  Object.entries(actions(ont))
    .filter((e): e is [string, Any] => isObj(e[1]))
    .sort((a, b) => sortStr(a[0], b[0]));
const whenId = (w: unknown): S => (isObj(w) ? (typeof w.passes === "string" ? w.passes : typeof w.fails === "string" ? w.fails : null) : null);

// ---------------------------------------------------------------------------------------------------------- action

function decisionRows(an: Analysis, id: string, a: Any): QueryRow[] {
  const d = map(a.decision);
  const disp = map(root(an.ont).dispositions);
  const conds = conditionsOf(a);
  const spec = new Map<string, boolean>();
  const isSpecified = (c: string) => {
    if (!spec.has(c)) spec.set(c, an.specified(id, conds.find((x) => x.id === c)));
    return spec.get(c)!;
  };
  const base = (r: Any): Omit<QueryRow, "row" | "when" | "requires" | "blockedBy"> => {
    const result = str(r.result);
    return { result, class: result !== null ? str(ownObj(disp, result)?.class) : null, cites: citesOf(r.cites), next: r.next ?? null };
  };
  const rows: QueryRow[] = [];
  const before: QueryRow["requires"] = [];
  let blockedBy: S = null;
  for (const [i, r] of arr(d.rows).entries()) {
    const raw = isObj(r) ? r : {};
    const w = raw.when;
    const when: QueryRow["when"] = isObj(w) && typeof w.passes === "string" ? { passes: w.passes } : isObj(w) && typeof w.fails === "string" ? { fails: w.fails } : null;
    const requires = [...before];
    if (when !== null) {
      const c = whenId(when)!;
      const s = isSpecified(c);
      requires.push({ condition: c, must: "passes" in when ? "pass" : "fail", specified: s });
      before.push({ condition: c, must: "passes" in when ? "fail" : "pass", specified: s });
    }
    rows.push({ row: i, when, ...base(raw), requires, blockedBy });
    if (when !== null && blockedBy === null && !requires[requires.length - 1].specified) blockedBy = requires[requires.length - 1].condition;
  }
  if (isObj(d.otherwise)) rows.push({ row: "otherwise", when: null, ...base(d.otherwise), requires: [...before], blockedBy });
  return rows;
}

function principalsOf(pr: unknown): QueryAlt["principals"] {
  return isObj(pr) ? { kinds: strs(pr.kinds), cite: citeOf(pr.cite) } : null;
}

function alt(x: Any): QueryAlt {
  return {
    keys: strs(x.keys),
    conditionalKeys: strs(x.conditional_keys),
    cite: citeOf(x.cite),
    conditionalCite: citeOf(x.conditional_cite),
    principals: principalsOf(x.principals),
  };
}

function permissionOf(p: unknown): QueryAction["permission"] {
  if (p === "unknown") return { form: "unknown" };
  if (isObj(p) && Array.isArray(p.any_of)) return { form: "keys", alternatives: p.any_of.filter(isObj).map(alt) };
  if (isObj(p) && "none" in p) return { form: "none", reason: str(p.none), cite: citeOf(p.cite), principals: principalsOf(p.principals) };
  if (isObj(p)) return { form: "keys", alternatives: [alt(p)] };
  return { form: "keys", alternatives: [] };
}

function transitionsBy(ont: unknown, id: string): QueryAction["transitions"] {
  const out: QueryAction["transitions"] = [];
  for (const [o, sm] of Object.entries(map(root(ont).stateMachines)))
    for (const t of arr(map(sm).transitions)) if (isObj(t) && strs(t.by).includes(id)) out.push({ object: o, from: str(t.from), to: str(t.to) });
  return out;
}

const LINK_KINDS = ["effect", "none", "unspecified"] as const;

export function queryAction(ont: unknown, id: string): QueryAction | null {
  const a = ownObj(actions(ont), id);
  if (a === undefined) return null;
  const an = new Analysis(ont);
  const editCites = map(a.edit_cites);
  const ik = a.idempotencyKey;
  const cc = a.crossContext;
  return {
    id,
    context: str(a.context),
    doc: str(a.doc),
    docTerm: str(a.doc_term),
    permission: permissionOf(a.permission),
    idempotencyKey: isObj(ik) && typeof ik.required === "boolean" ? { required: ik.required, cite: citeOf(ik.cite) } : null,
    parameters: Object.entries(map(a.parameters)).map(([name, p]) => ({
      name,
      type: typeOf(map(p).type),
      optional: map(p).optional === true,
      values: Array.isArray(map(p).values) ? map(p).values.filter((x: unknown) => typeof x === "string") : null,
      cite: citeOf(map(p).cite),
    })),
    conditions: conditionsOf(a).map((c) => ({
      id: c.id,
      expr: c.expr !== undefined ? (c.expr as Expr) : null,
      exprText: c.expr !== undefined ? showExpr(c.expr) : null,
      unspecified: str(c.unspecified),
      reads: arr(c.reads),
      cites: citesOf(c.cites),
      scenarios: strs(c.scenarios),
    })),
    decision: isObj(a.decision) ? { order: citeOf(map(a.decision.order).cite), rows: decisionRows(an, id, a) } : null,
    edits: strs(a.edits).map((prop) => ({ prop, cite: citeOf(map(own(editCites, prop)).cite) })),
    creates: strs(a.creates),
    emits: strs(a.emits),
    linkEffects: Object.entries(map(a.link_effects)).flatMap(([link, le]) => {
      const e = map(le);
      const kind = LINK_KINDS.find((k) => k in e);
      return kind === undefined ? [] : [{ link, kind, text: str(e[kind]), cite: citeOf(e.cite), scenarios: strs(e.scenarios) }];
    }),
    crossContext: isObj(cc) ? { via: str(cc.via), unspecified: str(cc.unspecified), cite: citeOf(cc.cite) } : null,
    evidence: str(a.evidence),
    transitions: transitionsBy(ont, id),
  };
}

// ---------------------------------------------------------------------------------------------------------- result

export function queryDisposition(ont: unknown, id: string): QueryDisposition | null {
  const d = ownObj(map(root(ont).dispositions), id);
  const an = new Analysis(ont);
  const rows: QueryDisposition["rows"] = [];
  for (const [aid, a] of sortedActions(ont)) {
    if (!isObj(a.decision)) continue;
    for (const r of decisionRows(an, aid, a)) if (r.result === id) rows.push({ action: aid, ...r });
  }
  if (d === undefined && rows.length === 0) return null;
  return { disposition: id, class: str(d?.class), cite: citeOf(d?.cite), rows };
}

// ---------------------------------------------------------------------------------------------------------- object

function scopeOf(ont: unknown, id: string): QueryObject["scope"] {
  const s = root(ont).scope;
  if (!isObj(s)) return null;
  if (arr(s.global).some((g) => isObj(g) && g.type === id)) return "global";
  if (isObj(s.root) && s.root.type === id) return "root";
  return "tenant";
}

// The property reads of a condition, through derived properties it references.
function conditionProps(an: Analysis, inp: Inputs): string[] {
  return uniqSorted([...inp.props, ...inp.derived.flatMap((d) => [...an.closure(d).props])]);
}

export function queryObject(ont: unknown, id: string): QueryObject | null {
  const o = ownObj(objects(ont), id);
  const outOfScope = o === undefined ? str(own(map(root(ont).outOfScopeObjectTypes), id)) : null;
  if (o === undefined && outOfScope === null) return null;
  const prefix = `${id}.`;
  const writers: QueryObject["writers"] = [];
  for (const [aid, a] of sortedActions(ont)) {
    const edits = strs(a.edits).filter((e) => e.startsWith(prefix));
    const creates = strs(a.creates).includes(id);
    if (edits.length || creates) writers.push({ action: aid, edits, creates });
  }
  if (o === undefined)
    return { id, context: null, datasource: null, doc: null, outOfScope, scope: null, properties: [], derived: [], stateMachine: null, links: [], writers, readers: [], unanalyzed: [] };
  const an = new Analysis(ont);
  const sm = ownObj(map(root(ont).stateMachines), id);
  const links: QueryObject["links"] = [];
  for (const l of arr(root(ont).linkTypes)) {
    if (!isObj(l) || typeof l.id !== "string") continue;
    if (l.from === id) links.push({ id: l.id, end: "from", other: str(l.to), cardinality: str(l.cardinality), via: str(l.via) });
    if (l.to === id) links.push({ id: l.id, end: "to", other: str(l.from), cardinality: str(l.cardinality), via: str(l.via) });
  }
  const readers: QueryObject["readers"] = [];
  const unanalyzed: QueryObject["unanalyzed"] = [];
  for (const [aid, a] of sortedActions(ont))
    for (const c of conditionsOf(a)) {
      const inp = an.conditionInputs(aid, c);
      if (inp.error !== undefined) unanalyzed.push({ at: `${aid}:${c.id}`, error: inp.error });
      const props = conditionProps(an, inp).filter((p) => p.startsWith(prefix));
      if (props.length) readers.push({ action: aid, condition: c.id, props });
    }
  unanalyzed.push(...derivedErrors(an, Object.keys(deriveds(ont)).filter((d) => isObj(own(deriveds(ont), d))).sort(sortStr)));
  return {
    id,
    context: str(o.context),
    datasource: str(o.datasource),
    doc: str(o.doc),
    outOfScope: null,
    scope: scopeOf(ont, id),
    properties: Object.entries(map(o.properties)).map(([name, p]) => {
      const pr = map(p), cv = pr.canonical_values, mf = pr.materializedFrom;
      return {
        name,
        class: str(pr.class),
        type: typeOf(pr.type),
        cite: citeOf(pr.cite),
        canonicalValues: isObj(cv) ? { values: strs(cv.values), cite: citeOf(cv.cite) } : null,
        materializedFrom: isObj(mf) ? { reads: strs(mf.reads), cites: citesOf(mf.cites) } : null,
      };
    }),
    derived: Object.entries(deriveds(ont))
      .filter(([, d]) => isObj(d) && d.of === id)
      .map(([did, d]) => ({ id: did, type: typeOf(d.type), docTerm: str(d.doc_term), exprText: d.expr !== undefined ? showExpr(d.expr) : null, cite: citeOf(d.cite) })),
    stateMachine: sm
      ? {
          doc: str(sm.doc),
          initial: str(sm.initial),
          terminal: strs(sm.terminal),
          transitions: arr(sm.transitions)
            .filter(isObj)
            .map((t) => ({ from: str(t.from), to: str(t.to), by: strs(t.by), outOfScope: str(t.out_of_scope) })),
        }
      : null,
    links,
    writers,
    readers,
    unanalyzed,
  };
}

// ---------------------------------------------------------------------------------------------------------- writes / reads

// "O.p": p is a property of O, or a derived property of O. null when neither is declared.
function target(ont: unknown, t: string): { obj: string; name: string; kind: "property" | "derived" } | null {
  const parts = t.split(".");
  if (parts.length !== 2) return null;
  const [obj, name] = parts;
  const o = ownObj(objects(ont), obj);
  if (o === undefined) return null;
  if (own(map(o.properties), name) !== undefined) return { obj, name, kind: "property" };
  if (ownObj(deriveds(ont), name)?.of === obj) return { obj, name, kind: "derived" };
  return null;
}

const derivedNode = (ont: unknown, id: string) => `${str(ownObj(deriveds(ont), id)?.of) ?? "?"}.${id}`;

function derivedErrors(an: Analysis, ids: Iterable<string>): QueryWrites["unanalyzed"] {
  const out: QueryWrites["unanalyzed"] = [];
  for (const id of ids) {
    const e = an.derivedInputs(id).error;
    if (e !== undefined) out.push({ at: `derivedProperties.${id}`, error: e });
  }
  return out;
}

export function queryWrites(ont: unknown, t: string): QueryWrites | null {
  const tg = target(ont, t);
  if (tg === null) return null;
  const acts = sortedActions(ont);
  const writersOf = (prop: string, path: string[]) =>
    acts.filter(([, a]) => strs(a.edits).includes(prop)).map(([aid, a]) => ({ action: aid, cite: citeOf(map(own(map(a.edit_cites), prop)).cite), path }));
  if (tg.kind === "property")
    return { target: t, kind: "property", unanalyzed: [], writers: writersOf(t, []), creators: acts.filter(([, a]) => strs(a.creates).includes(tg.obj)).map(([aid]) => aid) };
  // Breadth first from the derived target: each input once, by its shortest path.
  const an = new Analysis(ont);
  const writers: QueryWrites["writers"] = [];
  const seenProps = new Set<string>(), seenDerived = new Set<string>([tg.name]);
  let frontier: [string, string[]][] = [[tg.name, []]];
  while (frontier.length) {
    const next: [string, string[]][] = [];
    for (const [d, path] of frontier) {
      const inp = an.derivedInputs(d);
      for (const p of inp.props)
        if (!seenProps.has(p)) {
          seenProps.add(p);
          writers.push(...writersOf(p, [...path, p]));
        }
      for (const x of inp.derived)
        if (!seenDerived.has(x)) {
          seenDerived.add(x);
          next.push([x, [...path, derivedNode(ont, x)]]);
        }
    }
    frontier = next;
  }
  writers.sort((a, b) => a.path.length - b.path.length || sortStr(a.path.join(), b.path.join()) || sortStr(a.action, b.action));
  return { target: t, kind: "derived", unanalyzed: derivedErrors(an, seenDerived), writers, creators: [] };
}

export function queryReads(ont: unknown, t: string): QueryReads | null {
  const tg = target(ont, t);
  if (tg === null) return null;
  const an = new Analysis(ont);
  const isDerived = tg.kind === "derived";
  // Whether a derived property reaches the target through its chain.
  const reaches = (d: string) => (isDerived ? an.closure(d).derived.has(tg.name) : an.closure(d).props.has(t));
  const hit = (inp: Inputs) => ({
    direct: isDerived ? inp.derived.includes(tg.name) : inp.props.includes(t),
    via: inp.derived.filter((d) => d !== tg.name && reaches(d)),
  });
  const unanalyzed: QueryReads["unanalyzed"] = [];
  const conditions: QueryReads["conditions"] = [];
  for (const [aid, a] of sortedActions(ont)) {
    const rows = arr(map(a.decision).rows);
    for (const c of conditionsOf(a)) {
      const inp = an.conditionInputs(aid, c);
      if (inp.error !== undefined) unanalyzed.push({ at: `${aid}:${c.id}`, error: inp.error });
      const h = hit(inp);
      if (!h.direct && h.via.length === 0) continue;
      const rowIdx = rows.flatMap((r, i) => (isObj(r) && whenId(r.when) === c.id ? [i] : []));
      conditions.push({ action: aid, condition: c.id, source: inp.source, ...h, rows: rowIdx });
    }
  }
  const derived: QueryReads["derived"] = [];
  const ids = Object.keys(deriveds(ont)).filter((id) => isObj(own(deriveds(ont), id))).sort(sortStr);
  unanalyzed.push(...derivedErrors(an, ids));
  for (const id of ids) {
    if (isDerived && id === tg.name) continue;
    const h = hit(an.derivedInputs(id));
    if (h.direct || h.via.length) derived.push({ id, source: ownObj(deriveds(ont), id)!.expr !== undefined ? "expr" : "reads", ...h });
  }
  const materialized: string[] = [];
  for (const [o, ob] of Object.entries(objects(ont)))
    for (const [p, pr] of Object.entries(map(map(ob).properties)))
      if (strs(map(map(pr).materializedFrom).reads).some((r) => r === t || (isDerived && r === tg.name))) materialized.push(`${o}.${p}`);
  return { target: t, kind: tg.kind, materialized: materialized.sort(sortStr), unanalyzed, conditions, derived };
}

// ---------------------------------------------------------------------------------------------------------- cites

const pointer = (segs: string[]) => segs.map((s) => "/" + s.replace(/~/g, "~0").replace(/\//g, "~1")).join("");

// The subject of a claim: first segment, second segment, and for a list (such as conditions) or a decision, the entry.
function subjectOf(ont: unknown, segs: string[]): string {
  const name = (container: unknown, seg: string): string => {
    if (!Array.isArray(container)) return `.${seg}`;
    const el = container[Number(seg)];
    if (isObj(el) && typeof el.id === "string") return `.${el.id}`;
    if (isObj(el) && typeof el.name === "string") return `.${el.name}`;
    return `[${seg}]`;
  };
  if (segs.length === 0) return "";
  const r = root(ont);
  let out = segs[0];
  let cur: unknown = r[segs[0]];
  if (segs.length < 2) return out;
  out += name(cur, segs[1]);
  cur = isObj(cur) || Array.isArray(cur) ? (cur as Any)[segs[1]] : undefined;
  if (segs.length < 3) return out;
  const third = isObj(cur) ? cur[segs[2]] : undefined;
  if (Array.isArray(third) && segs.length >= 4) return `${out}.${segs[2]}${name(third, segs[3])}`;
  if (segs[2] === "decision" && segs.length >= 5 && segs[3] === "rows") return `${out}.decision.rows[${segs[4]}]`;
  if (segs[2] === "decision") return segs.length >= 4 ? `${out}.decision.${segs[3]}` : `${out}.decision`;
  return out;
}

type Claim = { doc: string; path: string; subject: string; quote: S };

// Every claim in document order: a mapping with string doc and quote (not entered), or a mapping with its own string doc
// (structural; listed before its children).
function claims(ont: unknown): Claim[] {
  const out: Claim[] = [];
  const walk = (x: unknown, segs: string[]) => {
    if (Array.isArray(x)) {
      x.forEach((y, i) => walk(y, [...segs, String(i)]));
      return;
    }
    if (!isObj(x)) return;
    if (typeof x.doc === "string" && typeof x.quote === "string") {
      out.push({ doc: x.doc, path: pointer(segs), subject: subjectOf(ont, segs), quote: x.quote });
      return;
    }
    if (typeof x.doc === "string" && segs.length > 0) out.push({ doc: x.doc, path: pointer(segs), subject: subjectOf(ont, segs), quote: str(x.doc_term) });
    for (const [k, y] of Object.entries(x)) walk(y, [...segs, k]);
  };
  walk(root(ont), []);
  return out;
}

export function queryCites(ont: unknown, anchor: string): QueryCites {
  return { anchor, claims: claims(ont).filter((c) => c.doc === anchor).map(({ path, subject, quote }) => ({ path, subject, quote })) };
}

// ---------------------------------------------------------------------------------------------------------- list

export const QUERY_LIST_KINDS = ["actions", "objects", "links", "derived", "dispositions", "anchors", "gaps"] as const;

export function queryList(ont: unknown, kind: string): QueryList | null {
  const r = root(ont);
  switch (kind) {
    case "actions":
      return {
        kind,
        items: Object.entries(actions(ont))
          .filter(([, a]) => isObj(a))
          .map(([id, a]) => {
            const p = permissionOf(a.permission);
            const keys = p.form === "keys" ? p.alternatives.flatMap((x) => [...x.keys, ...x.conditionalKeys]) : [];
            return { id, context: str(a.context), doc: str(a.doc), docTerm: str(a.doc_term), permissionKeys: uniqSorted(keys) };
          }),
      };
    case "objects":
      return {
        kind,
        items: [
          ...Object.entries(objects(ont)).map(([id, o]) => ({ id, context: str(map(o).context), datasource: str(map(o).datasource), outOfScope: null })),
          ...Object.entries(map(r.outOfScopeObjectTypes)).map(([id, reason]) => ({ id, context: null, datasource: null, outOfScope: str(reason) })),
        ],
      };
    case "links":
      return {
        kind,
        items: arr(r.linkTypes)
          .filter((l) => isObj(l) && typeof l.id === "string")
          .map((l) => ({ id: l.id, from: str(l.from), to: str(l.to), cardinality: str(l.cardinality), via: str(l.via), table: str(l.table) })),
      };
    case "derived":
      return {
        kind,
        items: Object.entries(deriveds(ont)).map(([id, d]) => ({ id, of: str(map(d).of), type: typeOf(map(d).type), docTerm: str(map(d).doc_term), hasExpr: map(d).expr !== undefined })),
      };
    case "dispositions":
      return { kind, items: Object.entries(map(r.dispositions)).map(([id, d]) => ({ id, class: str(map(d).class), cite: citeOf(map(d).cite) })) };
    case "anchors": {
      const counts = new Map<string, number>();
      for (const c of claims(ont)) counts.set(c.doc, (counts.get(c.doc) ?? 0) + 1);
      return { kind, items: [...counts.keys()].sort(sortStr).map((doc) => ({ doc, claims: counts.get(doc)! })) };
    }
    case "gaps":
      return {
        kind,
        items: arr(r.knownSourceGaps)
          .filter(isObj)
          .map((g) => ({ id: str(g.id), rule: str(g.rule), kind: str(g.kind), keys: strs(g.keys), conflict: str(g.conflict), proposed: str(g.proposed) })),
      };
    default:
      return null;
  }
}
