// The objects that an action touches: the objects of its `edits` (the part of "<Object>.<property>" before the dot), its
// `creates` and its `deletes`, kept when they are declared object types. Shared by the checker (R5, R6, R7) and the query
// `link`, so that both use one rule. The row effects (`effects` on a decision row or on `otherwise`) are read here too, for
// the checker (R5, R11), stage1-check (R1, R12) and query. Pure; it never throws on any parsed YAML.
import { isObj, own } from "./expr.js";

const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export function touchedObjects(action: Record<string, any>, objects: Record<string, any>): Set<string> {
  const objType = (o: unknown): o is string => isObj(own(objects, o as string));
  return new Set<string>(
    [...list(action.edits).map((e) => (typeof e === "string" ? e.split(".")[0] : e)), ...list(action.creates), ...list(action.deletes)].filter(objType),
  );
}

export const EFFECT_KINDS = ["edits", "creates", "deletes", "emits", "links"] as const;
export type RowEffects = Record<(typeof EFFECT_KINDS)[number], string[]>;

// The effects of one decision row or of otherwise: null when the row has none (or they are not a mapping); else each kind
// as its string entries, without repeats, in order ([] when left out).
export function rowEffects(row: unknown): RowEffects | null {
  if (!isObj(row) || !isObj(row.effects)) return null;
  const e = row.effects;
  return Object.fromEntries(
    EFFECT_KINDS.map((k) => [k, [...new Set(list(e[k]).filter((x): x is string => typeof x === "string"))]]),
  ) as RowEffects;
}

// The rows of an action's decision that have effects: rows.<i> in order, then otherwise.
export function statedRows(action: Record<string, any>): { label: string; effects: RowEffects }[] {
  const d = isObj(action) && isObj(action.decision) ? action.decision : {};
  const all: [string, unknown][] = [...list(d.rows).map((r, i): [string, unknown] => [`rows.${i}`, r]), ["otherwise", d.otherwise]];
  return all.flatMap(([label, r]) => {
    const effects = rowEffects(r);
    return effects === null ? [] : [{ label, effects }];
  });
}
