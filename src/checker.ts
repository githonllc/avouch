// Format-level ontology checker (rules R1–R12). Pure functions: no I/O. Project facts arrive through SourceFacts (contract.ts).
// Fail closed: a missing anchor, a parse failure or a missing field is a violation, never a skip.
import { IDENT, RULES, type Invocation, type Report, type RuleId, type SourceFacts, type StoreDelta, type Violation } from "./contract.js";
import { derivedPropertyType, isObj, newReads, type Stage1Ontology } from "./expr.js";
import { analyzeConditions, asReads, parseScope, quotesOf, stage1Violations } from "./stage1-check.js";

export { IDENT };

const CLASSES = ["canonical", "derived", "policy", "unknown"];
const CARDINALITY = /^(1|N):(1|N|M)$/;

type Any = any; // the ontology is untyped YAML; every field access below is validated (R1)

export function check(ontology: unknown, facts: SourceFacts): Report {
  const out: Violation[] = [];
  const info: string[] = [];
  const config = facts.config;
  const v = (rule: string, key: string, msg: string, kind = "generic") => out.push({ rule, key, msg, kind });
  const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  const arr = (x: unknown): Any[] => (Array.isArray(x) ? x : []);
  // membership in an ontology mapping: own keys only (`in` would follow the prototype chain, e.g. "toString")
  const own = (m: Record<string, Any>, k: unknown): k is string => typeof k === "string" && Object.hasOwn(m, k);

  if (!isObj(ontology)) return { violations: [{ rule: "R1", key: "root", msg: "ontology is not a mapping", kind: "structure" }], waived: [], info };
  const ont: Record<string, Any> = ontology;
  const scope = parseScope(ont); // shared with stage 1 (R2 field lists) and R6
  const conditionExprs = analyzeConditions(ont); // each expression condition type-checked once: R1 (stage 1), R4, R12

  // rule switches: a rule without an entry runs and is reported; a disabled rule drops its violations and diagnostics
  const disabled = new Map<string, string>();
  for (const r of RULES) {
    const sw = config.rules[r];
    if (sw === undefined) v(r, `config.rules.${r}`, `rule ${r} has no entry in config.rules`, "rule_not_configured");
    else if (sw !== true) {
      disabled.set(r, sw.disabled);
      info.push(`rule ${r} disabled: ${sw.disabled}`);
    }
  }
  const missingFact = (rule: RuleId, name: keyof SourceFacts) => {
    if (!disabled.has(rule)) v(rule, `facts.${name}`, `rule ${rule} needs the fact ${name}, which the source adapter does not provide`, "fact_missing");
  };
  if (facts.storeCatalog === undefined) missingFact("R2", "storeCatalog");
  if (facts.stateMachines === undefined) missingFact("R3", "stateMachines");
  if (facts.transitionTriggers === undefined) missingFact("R3", "transitionTriggers");
  if (facts.contextMembers === undefined) missingFact("R5", "contextMembers");
  if (facts.evidence === undefined) {
    missingFact("R6", "evidence");
    missingFact("R7", "evidence");
  }
  if (facts.eventCatalog === undefined) missingFact("R8", "eventCatalog");
  if (facts.scenarios === undefined) missingFact("R9", "scenarios");
  if (facts.permissions === undefined) missingFact("R10", "permissions");

  const section = (anchor: unknown, rule: string, key: string): { title: string; text: string } | null => {
    if (!isStr(anchor)) {
      v("R1", key, `doc anchor missing`);
      return null;
    }
    const s = facts.section(anchor);
    if (s === "missing") v(rule, key, `anchor ${anchor} is not found in the source`);
    else if (s === "ambiguous") v(rule, key, `anchor ${anchor} matches more than one source section`);
    else return s;
    return null;
  };

  // ------------------------------------------------------------------------------------------ R1
  if (ont.formatVersion !== 1) v("R1", "formatVersion", "formatVersion must be 1");
  const contexts: Record<string, string> = isObj(ont.contexts) ? ont.contexts : {};
  if (!isObj(ont.contexts) || Object.keys(contexts).length === 0) v("R1", "contexts", "contexts missing");
  const objects: Record<string, Any> = isObj(ont.objectTypes) ? ont.objectTypes : {};
  if (!isObj(ont.objectTypes)) v("R1", "objectTypes", "objectTypes missing");
  const objType = (o: unknown): o is string => own(objects, o) && isObj(objects[o]); // a declared object type that is a mapping
  const outOfScopeMap: Record<string, Any> = isObj(ont.outOfScopeObjectTypes) ? ont.outOfScopeObjectTypes : {};
  if (ont.outOfScopeObjectTypes !== undefined && !isObj(ont.outOfScopeObjectTypes)) v("R1", "outOfScopeObjectTypes", "must be a mapping name -> reason");
  for (const [n, r] of Object.entries(outOfScopeMap)) if (!isStr(r)) v("R1", `outOfScopeObjectTypes.${n}`, "needs a reason");
  const outOfScope = new Set<string>(Object.keys(outOfScopeMap));
  const infra = new Set<string>(arr(ont.infrastructureStores));
  if (ont.infrastructureStores !== undefined && !Array.isArray(ont.infrastructureStores)) v("R1", "infrastructureStores", "must be a list");
  const links: Any[] = arr(ont.linkTypes);
  if (!Array.isArray(ont.linkTypes)) v("R1", "linkTypes", "linkTypes missing");
  const commands: Record<string, Any> = isObj(ont.actionTypes) ? ont.actionTypes : {};
  if (!isObj(ont.actionTypes)) v("R1", "actionTypes", "actionTypes missing");
  const derived: Record<string, Any> = isObj(ont.derivedProperties) ? ont.derivedProperties : {};
  const stateMachines: Record<string, Any> = isObj(ont.stateMachines) ? ont.stateMachines : {};
  if (ont.stateMachines !== undefined && !isObj(ont.stateMachines)) v("R1", "stateMachines", "must be a mapping objectType -> state machine");
  for (const n of Object.keys(stateMachines)) if (!objType(n)) v("R1", `stateMachines.${n}`, "not a declared object type");
  const gaps: Any[] = arr(ont.knownSourceGaps);
  if (!Array.isArray(ont.knownSourceGaps)) v("R1", "knownSourceGaps", "missing (use [])");

  for (const [name, o] of Object.entries(objects)) {
    const p = `objectTypes.${name}`;
    if (!isObj(o)) {
      v("R1", p, "not a mapping");
      continue;
    }
    if (!own(contexts, o.context)) v("R1", p, `context ${o.context} not declared`);
    if (!isStr(o.datasource)) v("R1", p, "datasource missing");
    if (!isStr(o.doc)) v("R1", p, "doc missing");
    if (!isObj(o.properties)) v("R1", p, "properties missing (use {})");
    for (const [f, nl] of Object.entries(isObj(o.non_link_fields) ? o.non_link_fields : {}))
      if (!isObj(nl) || !isStr((nl as Any).reason) || !isObj((nl as Any).cite)) v("R1", `${p}.non_link_fields.${f}`, "needs reason and cite");
    if (o.non_link_fields !== undefined && !isObj(o.non_link_fields)) v("R1", p, "non_link_fields must be a mapping");
    for (const [pn, pr] of Object.entries(isObj(o.properties) ? o.properties : {})) {
      if (!isObj(pr) || !CLASSES.includes((pr as Any).class)) v("R1", `${p}.properties.${pn}`, `class must be one of ${CLASSES}`);
      else if ((pr as Any).class !== "unknown" && !isObj((pr as Any).cite)) v("R1", `${p}.properties.${pn}`, "class other than unknown needs a cite");
      const cv = isObj(pr) ? (pr as Any).canonical_values : undefined;
      if (cv !== undefined) {
        const sm = stateMachines[name];
        const states = isObj(sm) ? new Set([sm.initial, ...arr(sm.terminal), ...arr(sm.transitions).flatMap((t: Any) => [t?.from, t?.to])]) : null;
        if (!isObj(cv) || !Array.isArray(cv.values) || cv.values.length === 0 || !isObj(cv.cite)) v("R1", `${p}.properties.${pn}.canonical_values`, "needs values[] and cite");
        else if ((pr as Any).class === "canonical") v("R1", `${p}.properties.${pn}.canonical_values`, "only meaningful on a non-canonical property");
        else if (pn === config.stateProperty && states) for (const x of cv.values) if (!states.has(x)) v("R1", `${p}.properties.${pn}.canonical_values`, `${x} is not a ${name} state`);
      }
      const rf = isObj(pr) ? (pr as Any).materializedFrom : undefined;
      if (rf !== undefined && (!isObj(rf) || !Array.isArray(rf.reads) || rf.reads.length === 0 || !Array.isArray(rf.cites) || rf.cites.length === 0 || !rf.cites.every((c: Any) => isObj(c) && isObj(c.cite))))
        v("R1", `${p}.properties.${pn}.materializedFrom`, "needs reads[] and cites[{cite}]");
    }
  }
  const propClass = (ref: string): string | null => {
    const [o, p, ...rest] = ref.split(".");
    if (rest.length || !objType(o) || !isObj(objects[o].properties) || !own(objects[o].properties, p) || !isObj(objects[o].properties[p])) return null;
    const cls = objects[o].properties[p].class;
    return CLASSES.includes(cls) ? cls : null; // a property without a valid class does not resolve (R1 reports it)
  };
  const linkIds = new Set<string>();
  for (const [i, l] of links.entries()) {
    const p = `linkTypes[${i}]`;
    if (!isObj(l) || !isStr(l.id)) {
      v("R1", p, "link id missing");
      continue;
    }
    if (linkIds.has(l.id)) v("R1", `linkTypes.${l.id}`, "duplicate link id");
    linkIds.add(l.id);
    if (!objType(l.from) || !objType(l.to)) v("R1", `linkTypes.${l.id}`, `from/to must be declared object types`);
    if (!CARDINALITY.test(String(l.cardinality))) v("R1", `linkTypes.${l.id}`, "cardinality must be like N:1");
    if (!isStr(l.via) || !isStr(l.doc)) v("R1", `linkTypes.${l.id}`, "via and doc are required");
    if (l.table !== undefined && !isStr(l.table)) v("R1", `linkTypes.${l.id}`, "table must be a table name");
    if (l.create_rule !== undefined) {
      const r = l.create_rule;
      if (!isObj(r) || !own(contexts, r.context) || !Array.isArray(r.with_creates) || !isObj(r.cite))
        v("R1", `linkTypes.${l.id}.create_rule`, "needs context, with_creates[], cite");
      else if (r.exceptions !== undefined && (!isObj(r.exceptions) || !Array.isArray(r.exceptions.commands) || !isObj(r.exceptions.cite)))
        v("R1", `linkTypes.${l.id}.create_rule.exceptions`, "needs commands[] and cite");
    }
  }
  for (const [dn, d] of Object.entries(derived)) {
    if (!isObj(d) || !objType(d.of) || !isStr(d.doc) || !isStr(d.doc_term) || Array.isArray(d.reads) === (d.expr !== undefined))
      v("R1", `derivedProperties.${dn}`, "needs of, doc, doc_term, and exactly one of expr / reads[]");
    else for (const r of arr(d.reads)) if (propClass(r) === null) v("R1", `derivedProperties.${dn}`, `read ${r} does not resolve to a declared property`);
  }
  for (const [name, o] of Object.entries(objects))
    for (const [pn, pr] of Object.entries(isObj(o?.properties) ? o.properties : {}))
      for (const r of arr((pr as Any)?.materializedFrom?.reads)) if (propClass(r) === null) v("R1", `objectTypes.${name}.properties.${pn}.materializedFrom`, `read ${r} does not resolve`);
  const evidenceSeen = new Map<string, string>();
  for (const [cid, c] of Object.entries(commands)) {
    const p = `actionTypes.${cid}`;
    if (!config.actionIdPattern.test(cid)) v("R1", p, `action id must match ${config.actionIdPattern}`);
    if (!isObj(c)) {
      v("R1", p, "not a mapping");
      continue;
    }
    for (const f of ["doc", "doc_term"]) if (!isStr(c[f])) v("R1", p, `${f} missing`);
    if (!own(contexts, c.context)) v("R1", p, `context ${c.context} not declared`);
    if (c.permission === undefined) v("R1", p, "permission missing");
    else if (c.permission !== "unknown") {
      const pm = c.permission;
      // One keys-form object ({keys, cite, conditional_keys?, conditional_cite?}) or {none, cite}; `allowNone` is false inside any_of.
      const permShape = (pm: Any, allowNone: boolean): string | null => {
        const ks = isObj(pm) && Array.isArray(pm.keys) && pm.keys.length > 0 && pm.keys.every(isStr) && new Set(pm.keys).size === pm.keys.length;
        if (!(isObj(pm) && isObj(pm.cite) && pm.key === undefined && pm.any_of === undefined && (allowNone ? (isStr(pm.none) ? pm.keys === undefined : ks) : pm.none === undefined && ks)))
          return "permission must be unknown, {keys: [distinct keys], cite}, {none, cite} or {any_of: [{keys, cite}, ...]}";
        // Optional conditional keys: only alongside keys, with their own cite quoting the condition.
        if (pm.conditional_keys !== undefined || pm.conditional_cite !== undefined) {
          const ck = pm.conditional_keys;
          const cks = Array.isArray(ck) && ck.length > 0 && ck.every(isStr) && new Set(ck).size === ck.length;
          if (!(Array.isArray(pm.keys) && cks && isObj(pm.conditional_cite)))
            return "permission.conditional_keys needs keys, [distinct keys] and conditional_cite";
        }
        // Optional principals: the actor kinds the form admits, with their own cite.
        const pr = pm.principals, kinds = isObj(pr) ? pr.kinds : undefined;
        if (pr !== undefined && !(isObj(pr) && isObj(pr.cite) && Array.isArray(kinds) && kinds.length > 0 && kinds.every(isStr) && new Set(kinds).size === kinds.length))
          return "permission principals must be {kinds: [distinct kinds], cite}";
        return null;
      };
      if (isObj(pm) && pm.any_of !== undefined) {
        const alts = pm.any_of;
        if (!(Object.keys(pm).length === 1 && Array.isArray(alts) && alts.length >= 2))
          v("R1", p, "permission.any_of must be the only key and a list of at least 2 alternatives");
        else {
          const bad = alts.map((a) => permShape(a, false));
          bad.forEach((m, i) => m && v("R1", p, `permission.any_of[${i}]: ${m}`));
          // b is redundant iff b.keys ⊇ a.keys ∪ a.conditional_keys for another alternative a: whoever satisfies b holds all of a's keys, whether or not a's condition applies.
          // Only equal condition-free alternatives are redundant to each other; then only the later index is reported.
          if (!bad.some(Boolean)) {
            const need = (x: Any): string[] => [...x.keys, ...(x.conditional_keys ?? [])];
            // b also admits no actor kind that a does not: a has no principals, or b's kinds are a subset of a's
            const kinds = (x: Any): string[] | null => (isObj(x.principals) ? x.principals.kinds : null);
            const narrower = (b: Any, a: Any) => kinds(a) === null || (kinds(b) !== null && kinds(b)!.every((k) => kinds(a)!.includes(k)));
            const covers = (b: Any, a: Any) => need(a).every((k) => b.keys.includes(k)) && narrower(b, a);
            alts.forEach((b, j) => {
              const i = alts.findIndex((a, i) => i !== j && covers(b, a) && !(covers(a, b) && j < i));
              if (i >= 0) v("R1", p, `permission.any_of[${j}] is redundant: its keys include all keys of any_of[${i}]`);
            });
          }
        }
      } else {
        const m = permShape(pm, true);
        if (m) v("R1", p, m);
      }
    }
    for (const f of ["conditions", "edits", "emits"]) if (!Array.isArray(c[f])) v("R1", p, `${f} must be a list`);
    if (c.creates !== undefined && !Array.isArray(c.creates)) v("R1", p, "creates must be a list");
    if (!isObj(c.link_effects)) v("R1", p, "link_effects missing (use {})");
    if (c.crossContext !== undefined) {
      const cc = c.crossContext, ks = isObj(cc) ? ["via", "unspecified"].filter((k) => k in cc) : [];
      if (ks.length !== 1 || !isStr(cc[ks[0]]) || !isObj(cc.cite)) v("R1", `${p}.crossContext`, "exactly one of via / unspecified (non-empty string), and a cite");
    }
    if (c.idempotencyKey !== undefined) {
      const ik = c.idempotencyKey;
      if (!isObj(ik) || Object.keys(ik).sort().join() !== "cite,required" || typeof ik.required !== "boolean" || !isObj(ik.cite)) v("R1", `${p}.idempotencyKey`, "needs {required: boolean, cite}");
    }
    const params: Record<string, Any> = isObj(c.parameters) ? c.parameters : {};
    if (c.parameters !== undefined && !isObj(c.parameters)) v("R1", p, "parameters must be a mapping name -> {cite}");
    for (const [n, pv] of Object.entries(params)) {
      if (!isObj(pv) || !isObj(pv.cite)) v("R1", `${p}.parameters.${n}`, "needs a cite");
      const vs = isObj(pv) ? pv.values : undefined;
      if (vs !== undefined && !(pv.type === "enum" && Array.isArray(vs) && vs.length > 0 && vs.every(isStr) && new Set(vs).size === vs.length))
        v("R1", `${p}.parameters.${n}`, "values needs type enum and a non-empty list of distinct non-empty strings");
    }
    const pids = new Set<string>();
    for (const [i, pc] of arr(c.conditions).entries()) {
      if (!isObj(pc) || !isStr(pc.id) || !(Array.isArray(pc.cites) && pc.cites.length > 0 && pc.cites.every((x: Any) => isObj(x) && isObj(x.cite)))) {
        v("R1", `${p}.conditions[${i}]`, "needs id, cites[{cite}]");
        continue;
      }
      if (pc.reads !== undefined && !Array.isArray(pc.reads)) v("R1", `${p}.conditions.${pc.id}`, "reads must be a list");
      if (pc.reads_unspecified !== undefined && !isStr(pc.reads_unspecified)) v("R1", `${p}.conditions.${pc.id}`, "reads_unspecified must say what the doc leaves open");
      if (pids.has(pc.id)) v("R1", `${p}.conditions.${pc.id}`, "duplicate condition id");
      pids.add(pc.id);
      for (const r of arr(pc.reads))
        if (isObj(r) && "param" in r) {
          if (!isStr(r.param) || !Object.hasOwn(params, r.param)) v("R1", `${p}.conditions.${pc.id}`, `parameter read ${JSON.stringify(r)} does not resolve to a declared parameter of ${cid}`);
          if (r.values !== undefined && !(Array.isArray(r.values) && r.values.length > 0 && r.values.every(isStr)))
            v("R1", `${p}.conditions.${pc.id}`, `parameter read ${JSON.stringify(r)}: values must be a non-empty list of non-empty strings`);
        } else if (isObj(r) && "actor" in r) {
          if (r.actor !== "id" && r.actor !== "keys") v("R1", `${p}.conditions.${pc.id}`, `actor read ${JSON.stringify(r)} must be {actor: id} or {actor: keys}`);
        } else if (isObj(r)) {
          if (!isStr(r.prop) || propClass(r.prop) === null || !Array.isArray(r.values) || r.values.length === 0)
            v("R1", `${p}.conditions.${pc.id}`, `value read ${JSON.stringify(r)} needs a declared prop and values[]`);
        } else if (!own(derived, r) && propClass(r) === null) v("R1", `${p}.conditions.${pc.id}`, `read ${r} does not resolve`);
    }
    for (const e of arr(c.edits)) {
      const [o] = String(e).split(".");
      if (!(outOfScope.has(o) || propClass(e) !== null)) v("R1", p, `edit ${e} does not resolve to a declared property`);
    }
    for (const o of arr(c.creates)) if (!objType(o) && !outOfScope.has(o)) v("R1", p, `creates ${o}: unknown object`);
    for (const e of Object.keys(isObj(c.edit_cites) ? c.edit_cites : {}))
      if (!arr(c.edits).includes(e) || !isObj(c.edit_cites[e]?.cite)) v("R1", `${p}.edit_cites.${e}`, "must name an edit and carry a cite");
    for (const [lid, le] of Object.entries(isObj(c.link_effects) ? c.link_effects : {})) {
      const kinds = isObj(le) ? ["effect", "none", "unspecified"].filter((k) => k in le) : [];
      if (kinds.length !== 1 || !isStr((le as Any)[kinds[0]])) v("R1", `${p}.link_effects.${lid}`, "exactly one of effect / none / unspecified");
      else if (kinds[0] !== "none" && !isObj((le as Any).cite)) v("R1", `${p}.link_effects.${lid}`, `${kinds[0]} needs a cite`);
      if (!linkIds.has(lid)) v("R1", `${p}.link_effects.${lid}`, "unknown link id");
    }
    if (c.evidence !== undefined) {
      if (facts.evidence === undefined) v("R1", p, `evidence ${c.evidence} cannot be resolved: the source has no evidence adapter`);
      else if (!facts.evidence.has(c.evidence)) v("R1", p, `evidence ${c.evidence} is not provided by the evidence adapter`);
      else if (evidenceSeen.has(c.evidence)) v("R1", p, `evidence ${c.evidence} already claimed by ${evidenceSeen.get(c.evidence)}`);
      evidenceSeen.set(c.evidence, cid);
    }
  }
  const nonCmdRows: Any[] = arr(ont.permission_rows_not_commands);
  if (!Array.isArray(ont.permission_rows_not_commands)) v("R1", "permission_rows_not_commands", "missing (use [])");
  for (const [i, r] of nonCmdRows.entries())
    if (!isObj(r) || !isStr(r.name) || !isStr(r.reason) || !isObj(r.cite)) v("R1", `permission_rows_not_commands[${i}]`, "needs name, reason, cite");
    else if (own(commands, r.name)) v("R1", `permission_rows_not_commands[${i}]`, `${r.name} is an ontology command`);
  for (const [i, g] of gaps.entries())
    if (!isObj(g) || !isStr(g.id) || !/^R\d+$/.test(String(g.rule)) || !isStr(g.kind) || !Array.isArray(g.keys) || !isStr(g.doc_line) || !isStr(g.conflict) || !isStr(g.proposed))
      v("R1", `knownSourceGaps[${i}]`, "needs id, rule, kind, keys[], doc_line, conflict, proposed");
  if (config.idempotencyDeclarationRequired === true)
    for (const [cid, c] of Object.entries(commands))
      if (isObj(c) && c.idempotencyKey === undefined) v("R1", cid, "the profile requires an idempotencyKey declaration, but the action declares none", "idempotency_undeclared");
  // ------------------------------------------------------------------------------------------ R2
  const walkCites = (x: Any, path: string) => {
    if (Array.isArray(x)) x.forEach((y, i) => walkCites(y, `${path}[${i}]`));
    else if (isObj(x))
      for (const [k, y] of Object.entries(x)) {
        if (k === "cite") {
          const s = section(isObj(y) ? y.doc : undefined, "R2", `${path}.cite`);
          if (s && !(isStr(y.quote) && s.text.includes(y.quote))) v("R2", `${path}.cite`, `quote not found verbatim in ${y.doc}: ${y.quote}`);
        } else walkCites(y, `${path}.${k}`);
      }
  };
  walkCites({ objectTypes: objects, stateMachines, linkTypes: links, actionTypes: commands, permission_rows_not_commands: nonCmdRows, derivedProperties: derived, scope: ont.scope, dispositions: ont.dispositions }, "");
  for (const [name, o] of Object.entries(objects)) {
    if (!isObj(o)) continue;
    const s = section(o.doc, "R2", `objectTypes.${name}`);
    if (!s) continue;
    if (!IDENT(name).test(s.text)) v("R2", `objectTypes.${name}`, `object name not in ${o.doc}`);
    const fl = facts.fieldList(o.doc, name)?.value ?? null;
    if (!fl) v("R2", `objectTypes.${name}:fields`, `${o.doc} has no single field list headed ${name}`, "field_list_missing");
    else
      for (const pn of Object.keys(isObj(o.properties) ? o.properties : {}))
        if (!fl.has(pn)) v("R2", `${name}.${pn}`, `property ${pn} is not a field line (- ${pn}) of the ${name} field list in ${o.doc}`, "property_not_field");
  }
  const tableRefs: [string, unknown][] = [
    ...Object.entries(objects).map(([n, o]): [string, unknown] => [`objectTypes.${n}.datasource`, o?.datasource]),
    ...links.filter((l) => isObj(l) && l.table !== undefined).map((l): [string, unknown] => [`linkTypes.${l.id}.table`, l.table]),
    ...[...infra].map((t): [string, unknown] => [`infrastructureStores.${t}`, t]),
  ];
  if (facts.storeCatalog !== undefined)
    for (const [k, t] of tableRefs) if (!facts.storeCatalog.value.has(String(t))) v("R2", k, `table ${t} is not in the source store catalog`, "table_not_in_catalog");
  for (const l of links) {
    if (!isObj(l) || !isStr(l.id)) continue;
    const s = section(l.doc, "R2", `linkTypes.${l.id}`);
    if (s && isStr(l.via) && !IDENT(l.via).test(s.text)) v("R2", `linkTypes.${l.id}`, `via ${l.via} not in ${l.doc}`);
  }
  for (const [dn, d] of Object.entries(derived)) {
    const s = isObj(d) ? section(d.doc, "R2", `derivedProperties.${dn}`) : null;
    if (s && !s.text.includes(d.doc_term)) v("R2", `derivedProperties.${dn}`, `doc_term ${d.doc_term} not in ${d.doc}`);
  }
  const newNames: string[] = [];
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const s = section(c.doc, "R2", `actionTypes.${cid}`);
    if (s && !(isStr(c.doc_term) && s.text.includes(c.doc_term))) v("R2", `actionTypes.${cid}`, `doc_term ${c.doc_term} not verbatim in ${c.doc}`);
    if (!facts.containsTerm(cid)) newNames.push(`${cid} (doc_term ${c.doc_term} in ${c.doc})`);
    for (const [n, pv] of Object.entries(isObj(c.parameters) ? c.parameters : {})) {
      if (!isObj(pv) || !isStr(pv.cite?.quote)) continue;
      if (!IDENT(n).test(pv.cite.quote)) v("R2", `${cid}:${n}`, `parameter ${n} does not appear in its cite quote`, "parameter_not_in_quote");
      for (const x of Array.isArray(pv.values) ? pv.values.filter(isStr) : [])
        if (!IDENT(x).test(pv.cite.quote)) v("R2", `${cid}:${n}:${x}`, `parameter ${n} value ${x} does not appear in its cite quote`, "parameter_value_not_in_quote");
    }
  }
  info.push(`new action names (not in the source; owner to confirm): ${newNames.length ? newNames.join("; ") : "none"}`);
  // ------------------------------------------------------------------------------------------ R3
  const smFacts = facts.stateMachines;
  const triggers = facts.transitionTriggers;
  if (smFacts !== undefined)
    for (const [name, fact] of smFacts)
      if (objType(name) && (!isObj(stateMachines[name]) || stateMachines[name].doc !== fact.source.anchor))
        v("R3", `stateMachines.${name}`, `${fact.source.anchor} has a state machine for ${name}; stateMachines.${name}.doc must be ${fact.source.anchor}`);
  const byCmds = new Map<string, Set<string>>(); // object -> commands named in `by`
  for (const [name, o] of Object.entries(objects)) {
    if (!isObj(o) || !own(stateMachines, name)) continue;
    const st = stateMachines[name];
    const k = `stateMachines.${name}`;
    if (!isObj(st) || !isStr(st.initial) || !Array.isArray(st.terminal) || !Array.isArray(st.transitions)) {
      v("R1", k, "stateMachine needs doc, initial, terminal[], transitions[]");
      continue;
    }
    const s = section(st.doc, "R3", k);
    if (!s) continue;
    if (smFacts === undefined) continue;
    const fact = smFacts.get(name);
    if (!fact) {
      v("R3", k, `the source has no state machine for ${name}`);
      continue;
    }
    if (fact.value === null) continue;
    const docEdges = new Set<string>(fact.value.edges);
    const docInit: string[] = fact.value.initial;
    const docNodes = new Set<string>(fact.value.nodes);
    if (docInit.length !== 1) v("R3", k, `${st.doc}: expected exactly one initial edge, found ${docInit.length}`);
    const ontEdges = new Set<string>();
    const ontNodes = new Set<string>([st.initial, ...st.terminal]);
    for (const [i, t] of st.transitions.entries()) {
      if (!isObj(t) || !isStr(t.from) || !isStr(t.to) || !Array.isArray(t.by)) {
        v("R1", `${k}.transitions[${i}]`, "needs from, to, by[]");
        continue;
      }
      const e = `${t.from}->${t.to}`;
      if (ontEdges.has(e)) v("R3", k, `duplicate transition ${e}`);
      ontEdges.add(e);
      ontNodes.add(t.from).add(t.to);
      if (t.by.length === 0 && !isStr(t.out_of_scope)) v("R3", `${k}.${e}`, "by is empty: name the actions or give out_of_scope");
      if (t.by.length > 0 && t.out_of_scope !== undefined) v("R3", `${k}.${e}`, "by and out_of_scope are exclusive");
      const want = triggers?.get(name)?.get(e)?.value ?? new Set<string>();
      for (const c of t.by) {
        if (!own(commands, c)) v("R3", `${k}.${e}`, `by ${c} is not a defined command`);
        if (!byCmds.has(name)) byCmds.set(name, new Set());
        byCmds.get(name)!.add(c);
        if (triggers !== undefined && !want.has(c)) v("R3", `${name}:${e}:${c}`, `no source transition trigger binds ${c} to ${name} ${t.from} → ${t.to}`, "transition_binding_unsupported");
      }
      if (triggers !== undefined)
        for (const c of want) if (!t.by.includes(c)) v("R3", `${name}:${e}:${c}`, `the source binds ${c} to ${name} ${t.from} → ${t.to}; by omits it`, "transition_binding_missing");
    }
    const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
    for (const x of diff(docNodes, ontNodes)) v("R3", k, `state ${x} in ${st.doc} missing from ontology`);
    for (const x of diff(ontNodes, docNodes)) v("R3", k, `state ${x} not in ${st.doc}`);
    for (const x of diff(docEdges, ontEdges)) v("R3", k, `transition ${x} in ${st.doc} missing from ontology`);
    for (const x of diff(ontEdges, docEdges)) v("R3", k, `transition ${x} not in ${st.doc}`);
    if (triggers !== undefined)
      for (const x of diff(new Set(triggers.get(name)?.keys() ?? []), docEdges)) v("R3", k, `source trigger transition ${x} not in ${st.doc}`);
    if (docInit.length === 1 && docInit[0] !== st.initial) v("R3", k, `initial ${st.initial} ≠ doc ${docInit[0]}`);
    const sinks = new Set([...docNodes].filter((n) => ![...docEdges].some((e) => e.startsWith(`${n}->`))));
    const term = new Set<string>(st.terminal);
    if (diff(sinks, term).length || diff(term, sinks).length) v("R3", k, `terminal [${[...term]}] ≠ doc states without exits [${[...sinks]}]`);
    if (docInit.length === 1) {
      const seen = new Set([docInit[0]]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of docEdges) {
          const [a, b] = e.split("->");
          if (seen.has(a) && !seen.has(b)) seen.add(b), (grew = true);
        }
      }
      for (const n of docNodes) if (!seen.has(n)) v("R3", k, `${st.doc}: state ${n} unreachable from ${docInit[0]}`);
    }
  }
  if (smFacts !== undefined)
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const stateEdits = new Set(arr(c.edits).filter((e: string) => e.endsWith(`.${config.stateProperty}`)).map((e: string) => e.split(".")[0]));
    for (const o of stateEdits)
      if (objType(o) && isObj(stateMachines[o]) && !byCmds.get(o)?.has(cid)) v("R3", `${cid}:${o}.${config.stateProperty}`, `${cid} edits ${o}.${config.stateProperty} but is in no ${o} transition's by`);
    for (const [o, cs] of byCmds) if (cs.has(cid) && !stateEdits.has(o)) v("R3", `${cid}:${o}.${config.stateProperty}`, `${cid} is in a ${o} transition's by but does not edit ${o}.${config.stateProperty}`);
  }

  // ------------------------------------------------------------------------------------------ R4
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const bad = new Map<string, string>();
    for (const pc of arr(c.conditions)) {
      if (!isObj(pc)) continue;
      const quotes = quotesOf(pc.cites); // any one quote may support a value
      // an expression condition reads what its type check recorded (stage1-check), in the shape of hand-written reads
      const ex = isStr(pc.id) && pc.expr !== undefined ? conditionExprs.get(cid)?.get(pc.id) : undefined;
      const exReads = ex !== undefined && "reads" in ex ? ex.reads : undefined;
      for (const x of new Set(exReads?.literals.map(String)))
        if (!quotes.some((q) => IDENT(x).test(q))) v("R4", `${cid}:${pc.id}:${x}`, `condition ${pc.id} uses the literal ${x}, which does not appear in its cite quote`, "literal_unsupported");
      if (isStr(pc.reads_unspecified)) v("R4", `${cid}:${pc.id}`, `precondition ${pc.id}: the doc does not say which property it reads — ${pc.reads_unspecified}`, "precondition_reads_unspecified");
      // [read, suffix]: a hand-written read of a derived property with an expr stands for what that expression reads
      const reads: [Any, string][] = [];
      for (const r of pc.expr !== undefined ? (exReads ? asReads(exReads) : []) : arr(pc.reads)) {
        if (pc.expr === undefined && isStr(r) && own(derived, r) && derived[r]?.expr !== undefined) {
          const collected = newReads();
          try {
            derivedPropertyType(ont as unknown as Stage1Ontology, r, collected);
          } catch {
            continue; // R1 reports it (stage1-check checkDerived)
          }
          for (const x of asReads(collected)) reads.push([x, ` (via derived ${r})`]);
        } else reads.push([r, ""]);
      }
      for (const [r, suffix] of reads) {
        // parameter and actor reads are request inputs, not state: R4 does not classify them
        if (isObj(r) && "actor" in r) continue;
        if (isObj(r) && "param" in r) {
          for (const x of arr(r.values).filter(isStr)) // R1 reports empty and non-string values
            if (!quotes.some((q) => IDENT(x).test(q)))
              v("R4", `${cid}:${pc.id}:${x}`, `precondition ${pc.id} compares parameter ${r.param} with ${x}, which does not appear in its cite quote`, "parameter_value_unsupported");
          continue;
        }
        if (isObj(r)) {
          // value-level read: canonical property, or only values the doc marks canonical (canonical_values)
          const cls = propClass(r.prop);
          const [o, pn] = String(r.prop).split(".");
          const cv: string[] = arr(objects[o]?.properties?.[pn]?.canonical_values?.values);
          const off = arr(r.values).filter((x: string) => !cv.includes(x));
          if (cls !== null && cls !== "canonical" && cls !== "policy" && off.length) bad.set(r.prop, `precondition ${pc.id} reads ${r.prop} values [${off}], class ${cls}; canonical values are [${cv}]`);
          continue;
        }
        const via = suffix ? [[r, suffix]] : own(derived, r) ? arr(derived[r]?.reads).map((x: string) => [x, ` (via derived ${r})`]) : [[r, ""]];
        for (const [ref, how] of via) {
          const cls = propClass(ref);
          if (cls !== null && cls !== "canonical" && cls !== "policy") bad.set(ref, `precondition ${pc.id} reads ${ref}${how}, class ${cls}`);
        }
      }
    }
    for (const [ref, msg] of bad) v("R4", `${cid}:${ref}`, msg, "precondition_reads_non_canonical");
  }
  // canonical_values are not self-authorized: each value must appear in its own (verbatim, R2) cite quote
  for (const [name, o] of Object.entries(objects))
    for (const [pn, pr] of Object.entries(isObj(o?.properties) ? o.properties : {})) {
      const cv = (pr as Any)?.canonical_values;
      if (!isObj(cv)) continue;
      for (const x of arr(cv.values))
        if (!(isStr(cv.cite?.quote) && IDENT(String(x)).test(cv.cite.quote)))
          v("R4", `${name}.${pn}:${x}`, `canonical value ${x} does not appear in its cite quote`, "canonical_value_unsupported");
    }

  // ------------------------------------------------------------------------------------------ R5
  const members = new Map<string, Set<string>>();
  for (const [ctx, f] of facts.contextMembers ?? []) members.set(ctx, f.value);
  if (facts.contextMembers !== undefined) {
  for (const [name, o] of Object.entries(objects))
    if (isObj(o) && members.has(o.context) && !members.get(o.context)!.has(name)) v("R5", `object:${name}`, `the source does not list ${name} under ${o.context}`);
  const entities = new Set([...members.values()].flatMap((m) => [...m]).filter((x) => /^[A-Z][A-Za-z]+$/.test(x)));
  for (const x of entities)
    if (!objType(x) && !outOfScope.has(x)) v("R5", `entity:${x}`, `the source lists entity ${x}; it must be in objectTypes or outOfScopeObjectTypes`, "context_entity_uncovered");
  for (const x of outOfScope) if (!entities.has(x)) v("R5", `entity:${x}`, `outOfScopeObjectTypes.${x} is not a source entity`, "out_of_scope_unknown");
  }
  const touched = (c: Any) =>
    new Set<string>([...arr(c.edits).map((e: string) => e.split(".")[0]), ...arr(c.creates)].filter(objType));
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const cross = [...touched(c)].filter((o) => objects[o].context !== c.context);
    const cc = c.crossContext, unspec = isObj(cc) && isStr(cc.unspecified);
    if (cross.length && unspec) v("R5", cid, `${c.context} command touches ${cross.join(", ")} of another context; the source does not say the mechanism: ${cc.unspecified}`, "mechanism_unspecified");
    else if (cross.length && !(isObj(cc) && config.crossContextMechanisms.includes(cc.via) && isObj(cc.cite)))
      v("R5", cid, `${c.context} command touches ${cross.join(", ")} of another context without a declared crossContext mechanism (${config.crossContextMechanisms.join(", ")})`);
    if (!cross.length && c.crossContext !== undefined) v("R5", cid, "crossContext declared but no object of another context is touched");
    for (const l of links)
      if (isObj(l) && isObj(l.create_rule) && arr(c.creates).includes(l.from)) {
        const r = l.create_rule;
        if (arr(r.exceptions?.commands).includes(cid)) continue;
        if (c.context !== r.context || !arr(r.with_creates).every((o: string) => arr(c.creates).includes(o)))
          v("R5", `${cid}:${l.id}`, `${cid} (${c.context}) creates ${l.from} with ${l.id}, but ${r.cite?.doc} allows only ${r.context} commands that also create ${arr(r.with_creates).join(", ")}`);
      }
  }
  // ------------------------------------------------------------------------------------------ R6
  // evidence aggregates are derived here from the invocation records, never stored by the adapter. Records are runtime data
  // (for example parsed JSON) and may break the type: one shape predicate decides what is committed or rejected; every other
  // shape is neither (reported as an R7 info diagnostic) and adds nothing
  const rowsOk = (x: unknown, image: string) => Array.isArray(x) && x.every((r) => isObj(r) && (typeof r.row === "string" || typeof r.row === "number") && isObj(r[image]));
  const storeDeltaOk = (d: unknown) => isObj(d) && rowsOk(d.inserted, "after") && rowsOk(d.updated, "changes") && rowsOk(d.deleted, "before");
  const shapeDefects = (i: unknown): string[] => {
    if (!isObj(i)) return ["is not a record"];
    const bad: string[] = [];
    if (!isStr(i.id)) bad.push("has no string id");
    if (!(Number.isInteger(i.rolledBackAttempts) && i.rolledBackAttempts >= 0)) bad.push("rolledBackAttempts is not a non-negative integer");
    if (i.outcome === "committed") {
      if (!isObj(i.delta)) bad.push("is committed but has no delta");
      else {
        if (!isObj(i.delta.stores)) bad.push("is committed but delta.stores is not a mapping");
        else for (const [tb, d] of Object.entries(i.delta.stores)) if (!storeDeltaOk(d)) bad.push(`is committed but delta.stores.${tb} is not a store delta (inserted, updated, deleted rows)`);
        if (!Array.isArray(i.delta.events) || !i.delta.events.every(isStr)) bad.push("is committed but delta.events is not a list of event types");
      }
    } else if (i.outcome === "rejected") {
      if (i.delta !== null) bad.push(i.delta === undefined ? "is rejected but has no delta key (must be null)" : "is rejected but has a delta (must be null)");
    } else bad.push(`has outcome ${String(i.outcome)}, neither committed nor rejected`);
    return bad;
  };
  // each evidence id's list is partitioned once; a list that is not an array counts as empty and is one malformed entry
  type Part = { committed: Extract<Invocation, { outcome: "committed" }>[]; rejected: Extract<Invocation, { outcome: "rejected" }>[]; malformed: { id: string; bad: string[] }[] };
  const parts = new Map<string, Part>();
  for (const [b, list] of facts.evidence ?? []) {
    const p: Part = { committed: [], rejected: [], malformed: [] };
    if (!Array.isArray(list)) p.malformed.push({ id: "list", bad: ["is not a list"] });
    else
      for (const [n, i] of (list as unknown[]).entries()) {
        const bad = shapeDefects(i);
        if (bad.length) p.malformed.push({ id: isObj(i) && isStr(i.id) ? i.id : `[${n}]`, bad }); // a record without an id is keyed by its list position
        else if ((i as Invocation).outcome === "committed") p.committed.push(i as Part["committed"][number]);
        else p.rejected.push(i as Part["rejected"][number]);
      }
    parts.set(b, p);
  }
  const part = (id: unknown): Part => (typeof id === "string" ? parts.get(id) : undefined) ?? { committed: [], rejected: [], malformed: [] };
  const hasRows = (d: StoreDelta) => d.inserted.length + d.updated.length + d.deleted.length > 0;
  // over the committed invocations of one evidence id: stores with a changed row, stores with an inserted row,
  // columns changed on existing rows (per store; checked per object), and the events written
  const observe = (id: unknown) => {
    const committed = part(id).committed;
    const rowStores = new Set<string>(), insertedStores = new Set<string>(), insDelStores = new Set<string>(), events = new Set<string>();
    const changedCols = new Map<string, Set<string>>();
    for (const i of committed) {
      for (const e of i.delta.events) events.add(e);
      for (const [tb, d] of Object.entries(i.delta.stores)) {
        if (hasRows(d)) rowStores.add(tb);
        if (d.inserted.length) insertedStores.add(tb);
        if (d.inserted.length || d.deleted.length) insDelStores.add(tb);
        for (const u of d.updated) for (const col of Object.keys(u.changes)) changedCols.set(tb, (changedCols.get(tb) ?? new Set<string>()).add(col));
      }
    }
    return { committed, rowStores, insertedStores, insDelStores, changedCols, events };
  };
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const t = touched(c);
    const need = new Set(links.filter((l) => isObj(l) && (t.has(l.from) || t.has(l.to))).map((l) => l.id as string));
    const have: Record<string, Any> = isObj(c.link_effects) ? c.link_effects : {};
    for (const lid of need) {
      if (!own(have, lid)) v("R6", `${cid}:${lid}`, `${cid} touches ${[...t].join(", ")} but link ${lid} has no link_effects entry`, "link_effect_missing");
      else if (isObj(have[lid]) && "unspecified" in have[lid]) v("R6", `${cid}:${lid}`, `effect on ${lid} is not specified by the doc: ${have[lid].unspecified}`, "effect_unspecified");
    }
    for (const lid of Object.keys(have)) if (!need.has(lid)) v("R6", `${cid}:${lid}:stray`, `link_effects.${lid}: ${lid} is not incident to any touched object`);
    // a `none` effect on a link with its own table contradicts an observed write to that table (R7 ground truth)
    const written = observe(c.evidence).rowStores;
    for (const l of links)
      if (isObj(l) && isStr(l.table) && isObj(have[l.id]) && "none" in have[l.id] && written.has(l.table))
        v("R6", `${cid}:${l.id}`, `link_effects.${l.id} is none, but the evidence (${c.evidence}) wrote its table ${l.table}`, "none_but_written");
  }
  // link catalog completeness: every *_id field of each field list is a declared link or a declared non-link field;
  // with a declared scope, the tenant field of a tenant type counts as declared
  const tenantField = (name: string, f: string) => scope !== null && scope.isTenant(name) && f === scope.by;
  for (const [name, o] of Object.entries(objects)) {
    if (!isObj(o)) continue;
    const fl = facts.fieldList(o.doc, name)?.value ?? null;
    if (!fl) continue; // reported by R2 (field_list_missing / anchor)
    const nl: Record<string, Any> = isObj(o.non_link_fields) ? o.non_link_fields : {};
    for (const f of fl.keys())
      if (config.linkFieldPattern.test(f) && !links.some((l) => isObj(l) && l.from === name && l.via === f) && !own(nl, f) && !tenantField(name, f))
        v("R6", `${name}.${f}`, `field ${f} of ${name} (${o.doc}) is neither a declared link nor in non_link_fields`, "link_catalog_incomplete");
    for (const f of Object.keys(nl)) {
      if (!fl.has(f)) v("R6", `${name}.${f}`, `non_link_fields.${f} is not a field of ${name} in ${o.doc}`, "non_link_field_stray");
      if (links.some((l) => isObj(l) && l.from === name && l.via === f)) v("R6", `${name}.${f}`, `${f} is a declared link; remove it from non_link_fields`, "non_link_field_stray");
      else if (fl.has(f) && tenantField(name, f)) v("R6", `${name}.${f}`, `${f} is the scope field of the tenant type ${name}; remove it from non_link_fields`, "non_link_field_stray");
    }
  }
  // ------------------------------------------------------------------------------------------ R7
  const claimed = new Set<string>();
  if (config.evidenceRequired === true)
    for (const [cid, c] of Object.entries(commands))
      if (isObj(c) && c.evidence === undefined) v("R7", cid, "the profile requires evidence, but the action declares none", "evidence_missing");
  if (facts.evidence !== undefined) {
  // a pure link table (not any object's table) may be written when the action declares an `effect` on that link;
  // an object's table still needs the object in edits / creates
  const objTables = new Set(Object.values(objects).map((o: Any) => o?.datasource));
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c) || c.evidence === undefined) continue;
    claimed.add(c.evidence);
    const { rejected } = part(c.evidence);
    const { committed, rowStores, insertedStores, insDelStores, changedCols, events } = observe(c.evidence);
    const attempts = [...committed, ...rejected].reduce((n, i) => n + i.rolledBackAttempts, 0); // malformed records add nothing
    info.push(`R7 ${cid} (${c.evidence}, ${committed.length} committed, ${rejected.length} rejected invocations, ${attempts} rolled-back attempts): changed {${[...rowStores].sort()}} events {${[...events].sort()}}`);
    if (!committed.length) {
      v("R7", `${cid}:no-batch`, `no committed invocation of ${c.evidence} was observed`);
      continue;
    }
    const touchedObjs = [...touched(c)];
    const declared = new Set<string>(touchedObjs.map((o) => objects[o].datasource));
    const pureLink = (l: Any) => isObj(l) && isStr(l.table) && !objTables.has(l.table) && isObj(c.link_effects?.[l.id]) && "effect" in c.link_effects[l.id];
    const linkTables = links.filter(pureLink).map((l) => l.table as string);
    const allowed = new Set([...declared, ...linkTables, ...infra]);
    for (const tb of rowStores) if (!allowed.has(tb)) v("R7", `${cid}:${tb}`, `evidence (${c.evidence}) changed store ${tb}, not declared by edits/creates`, "table_undeclared");
    for (const e of events) if (!arr(c.emits).includes(e)) v("R7", `${cid}:event:${e}`, `evidence (${c.evidence}) wrote event ${e}, not in emits`, "event_undeclared");
    // column level, per touched object (objects may share a store): a column changed on an existing row of its store must
    // be a property of a resolvable edit of that same object; reported once per touched object and column
    const editCols = new Map<string, Set<string>>(); // per object
    const resolvedEdits = arr(c.edits).filter((e: unknown): e is string => isStr(e) && propClass(e) !== null); // the R1 resolver
    for (const e of resolvedEdits) {
      const [o, p] = e.split(".");
      editCols.set(o, (editCols.get(o) ?? new Set<string>()).add(p));
    }
    for (const o of touchedObjs)
      for (const col of changedCols.get(objects[o].datasource) ?? [])
        if (!editCols.get(o)?.has(col))
          v("R7", `${cid}:${o}.${col}`, `evidence (${c.evidence}) changed column ${col} on an existing row of ${objects[o].datasource} (store of ${o}), not declared in edits`, "column_undeclared");
    // effect witness: every resolvable declared effect is made by at least one committed invocation; unresolvable edits are R1
    // only, and out-of-scope objects have no store
    const unwitnessed = (key: string, what: string) => v("R7", `${cid}:${key}`, `no committed invocation of ${c.evidence} ${what}`, "effect_unwitnessed");
    for (const e of resolvedEdits) {
      const [o, p] = e.split(".");
      if (!changedCols.get(objects[o].datasource)?.has(p)) unwitnessed(e, `updated ${e} on an existing row of ${objects[o].datasource}`);
    }
    for (const o of arr(c.creates))
      if (objType(o) && !insertedStores.has(objects[o].datasource)) unwitnessed(`creates:${o}`, `inserted a row into ${objects[o].datasource}`);
    for (const l of links.filter(pureLink))
      if (!insDelStores.has(l.table)) unwitnessed(`link:${l.id}`, `inserted or deleted a row of the link store ${l.table}`);
  }
  for (const [b, p] of parts) {
    for (const { id, bad } of p.malformed) info.push(`R7 evidence ${b}: malformed invocation ${id}: ${bad.join("; ")}`);
    if (!claimed.has(b) && p.committed.length) v("R7", `unclaimed:${b}`, `evidence ${b} has committed invocations but no action declares evidence: ${b}`);
  }
  }

  // ------------------------------------------------------------------------------------------ R8
  for (const [cid, c] of Object.entries(commands))
    for (const e of arr(isObj(c) ? c.emits : [])) if (facts.eventCatalog !== undefined && !facts.eventCatalog.value.has(e)) v("R8", `${cid}:${e}`, `event ${e} is not in the source event catalog`);

  // ------------------------------------------------------------------------------------------ R9
  const scenarioIds = facts.scenarios?.ids ?? new Set<string>();
  const cites = facts.scenarios?.cites ?? new Map<string, Set<string>>();
  for (const [scen, ids] of cites)
    for (const id of ids) if (!own(commands, id)) v("R9", `${scen}:${id}`, `${scen} cites unknown action ${id}`);
  if (facts.scenarios !== undefined) {
  let pre = 0, preCov = 0, eff = 0, effCov = 0;
  const enforced = config.scenarioCoverage === "enforced";
  const p0 = (w: string) => w.slice(w.indexOf(" ") + 1);
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const by = [...cites].filter(([, s]) => s.has(cid)).map(([k]) => k);
    if (!by.length) v("R9", `uncited:${cid}`, `no story scenario cites ${cid}`);
    info.push(`R9 ${cid}: cited by ${by.length} scenario(s) ${by.join(" ")}`);
    const items: [string, Any][] = [
      ...arr(c.conditions).map((p: Any): [string, Any] => [`precondition ${p?.id}`, p]),
      ...Object.entries(isObj(c.link_effects) ? c.link_effects : {}).map(([l, e]): [string, Any] => [`link_effect ${l}`, e]),
    ];
    for (const [what, it] of items) {
      if (!isObj(it)) continue;
      const isPre = what.startsWith("precondition");
      if (!isPre && "none" in it) continue;
      isPre ? pre++ : eff++;
      const covered = Array.isArray(it.scenarios) && it.scenarios.length > 0;
      if (covered) isPre ? preCov++ : effCov++;
      else if (enforced && isPre) v("R9", `${cid}:${p0(what)}`, `${what} of ${cid} lists no scenario`, "criterion_uncovered");
      else if (enforced && !("unspecified" in it)) v("R9", `${cid}:${p0(what)}`, `${what} of ${cid} lists no scenario`, "effect_uncovered");
      for (const s of arr(it.scenarios))
        if (!scenarioIds.has(s)) v("R9", `${cid}:${what}:${s}`, `${what} lists scenario ${s}, which does not exist`);
        else if (!cites.get(s)?.has(cid)) v("R9", `${cid}:${what}:${s}`, `${what} lists scenario ${s}, which does not cite ${cid}`);
    }
  }
  info.push(`coverage (${enforced ? "enforced" : "printed, not enforced"}): preconditions with scenarios ${preCov}/${pre}; non-none link effects with scenarios ${effCov}/${eff}`);
  }

  // ----------------------------------------------------------------------------------------- R10
  const perm = facts.permissions;
  if (perm !== undefined) {
  if (perm.rows.source.anchor !== config.requiredSource.R10)
    v("R10", "permissions", `permission rows come from ${perm.rows.source.anchor}, but permission cites must name ${config.requiredSource.R10}`, "source_mismatch");
  for (const cid of perm.rows.value.keys())
    if (!own(commands, cid)) {
      if (nonCmdRows.some((r) => isObj(r) && r.name === cid)) info.push(`source permission row names ${cid}: declared in permission_rows_not_commands, binds nothing`);
      else v("R10", `permissions:${cid}`, `source permission row names ${cid}, which is neither a declared action nor declared in permission_rows_not_commands`, "permission_row_undeclared");
    }
  if (perm.rows.value.size)
    for (const r of nonCmdRows)
      if (isObj(r) && isStr(r.name) && !perm.rows.value.has(r.name))
        v("R10", `permission_rows_not_commands:${r.name}`, `declared non-command ${r.name} is not in the source permission table`, "permission_row_stale");
  for (const [cid, c] of Object.entries(commands)) {
    if (!isObj(c)) continue;
    const p = c.permission;
    const row = perm.rows.value.get(cid);
    if (p === "unknown") v("R10", cid, "permission unknown: the doc names no key for this command", "permission_unknown");
    else if (!isObj(p)) continue; // R1
    else if (!row) v("R10", cid, `${cid} has no row in the source permission table`, "permission_unmapped");
    else {
      // Each keys-form (or any_of alternative): disjoint lists, catalog, cites. Returns the keys it names.
      const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
      const formChecks = (f: Any, idx?: number): string[] => {
        const base: string[] = Array.isArray(f.keys) ? f.keys.filter(isStr) : [];
        const cond: string[] = Array.isArray(f.conditional_keys) ? f.conditional_keys.filter(isStr) : [];
        const pk = [...base, ...cond];
        const outside = pk.filter((k) => !perm.catalog.value.has(k));
        const overlap = cond.filter((k) => base.includes(k));
        if (overlap.length) v("R10", cid, `permission ${overlap.join(", ")} is in both keys and conditional_keys`, "permission_conditional_overlap");
        if (outside.length) v("R10", cid, `permission ${outside.join(", ")} is not in the source permission catalog`, "permission_not_in_catalog");
        if (!(isStr(f.cite?.quote) && f.cite.doc === config.requiredSource.R10 && row.text.includes(f.cite.quote)))
          v("R10", cid, `permission cite must quote the ${cid} row of the source permission table`, "permission_cite_mismatch");
        const cc = f.conditional_cite;
        if (cond.length && !(isStr(cc?.quote) && cc.doc === config.requiredSource.R10 && row.text.includes(cc.quote) && cond.every((k) => perm.quoteNamesKey(cc.quote, k))))
          v("R10", cid, `conditional_cite must quote the condition in the ${cid} row of the source permission table, naming each conditional key`, "permission_cite_mismatch");
        // any_of only: each alternative's cite must itself name the keys it lists.
        if (idx !== undefined) {
          const cq = isStr(f.cite?.quote) ? f.cite.quote : "", ccq = isStr(f.conditional_cite?.quote) ? f.conditional_cite.quote : "";
          const unnamed = [...base.filter((k) => !perm.quoteNamesKey(cq, k)), ...cond.filter((k) => !perm.quoteNamesKey(cq, k) && !perm.quoteNamesKey(ccq, k))];
          if (unnamed.length) v("R10", cid, `any_of[${idx}] cite does not name ${unnamed.join(", ")}`, "permission_cite_mismatch");
        }
        return pk;
      };
      // Keys ∪ conditional_keys (for any_of: over all alternatives) must equal the row's key set.
      const pk: string[] = Array.isArray(p.any_of)
        ? p.any_of.flatMap((f: Any, i: number) => (isObj(f) ? formChecks(f, i) : [])) // keep the original index; R1 reports non-objects
        : formChecks(p);
      const outside = pk.filter((k) => !perm.catalog.value.has(k));
      if (!outside.length && !same(pk, [...row.keys])) v("R10", cid, `permission [${pk.length ? [...new Set(pk)] : "none"}] ≠ source row [${[...row.keys]}]`, "permission_mismatch");
    }
  }
  }

  // ----------------------------------------------------------------------------------------- R11
  // A materialized property is written in the same operation as the facts it is computed from: every action that writes an input lists it.
  for (const [name, o] of Object.entries(objects))
    for (const [pn, pr] of Object.entries(isObj(o?.properties) ? o.properties : {})) {
      const reads: string[] = arr((pr as Any)?.materializedFrom?.reads);
      if (!reads.length) continue;
      const target = `${name}.${pn}`;
      for (const [cid, c] of Object.entries(commands)) {
        if (!isObj(c)) continue;
        const hit = reads.filter((r) => arr(c.edits).includes(r) || arr(c.creates).includes(r.split(".")[0]));
        if (hit.length && !arr(c.edits).includes(target))
          v("R11", `${cid}:${target}`, `${cid} writes ${hit.join(", ")} (inputs of ${target}) but does not list ${target} in edits`, "materialization_missing");
      }
    }

  // ------------------------------------------------------------------------------------- unknowns
  const unknown = Object.entries(objects).flatMap(([n, o]) =>
    Object.entries(isObj(o?.properties) ? o.properties : {}).filter(([, p]) => (p as Any)?.class === "unknown").map(([pn]) => `${n}.${pn}`),
  );
  info.push(`class: unknown (the source does not classify): ${unknown.join(", ") || "none"}`);


  // ----------------------------------------------------------------------- stage 1: R1, R2, R4, R12
  // expressions, scope, dispositions and decision tables (./stage1-check)
  out.push(...stage1Violations({ ont, facts, scope, conditions: conditionExprs }));

  // -------------------------------------------------------------------------------------- waivers
  const reported = [...out, ...facts.diagnostics].filter((x) => !disabled.has(x.rule));
  info.unshift(...facts.info);
  const violations: Violation[] = [];
  const waived: Violation[] = [];
  const used = new Set<string>();
  for (const x of reported) {
    const g = gaps.find((g) => isObj(g) && g.rule === x.rule && g.kind === x.kind && arr(g.keys).includes(x.key));
    if (g) waived.push({ ...x, msg: `[${g.id}] ${x.msg}` }), used.add(`${g.id}|${x.key}`);
    else violations.push(x);
  }
  // a waiver that suppresses nothing is itself a failure, reported under the waiver's rule
  for (const g of gaps)
    if (isObj(g))
      for (const k of arr(g.keys))
        if (!used.has(`${g.id}|${k}`)) violations.push({ rule: g.rule, key: `${g.id}:${k}`, msg: `knownSourceGaps ${g.id}: ${g.rule}/${g.kind} ${k} no longer fails — remove the waiver`, kind: "stale_waiver" });
  return { violations, waived, info };
}
