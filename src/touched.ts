// The objects that an action touches: the objects of its `edits` (the part of "<Object>.<property>" before the dot), its
// `creates` and its `deletes`, kept when they are declared object types. Shared by the checker (R5, R6, R7) and the query
// `link`, so that both use one rule. Pure; it never throws on any parsed YAML.
import { isObj, own } from "./expr.js";

const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export function touchedObjects(action: Record<string, any>, objects: Record<string, any>): Set<string> {
  const objType = (o: unknown): o is string => isObj(own(objects, o as string));
  return new Set<string>(
    [...list(action.edits).map((e) => (typeof e === "string" ? e.split(".")[0] : e)), ...list(action.creates), ...list(action.deletes)].filter(objType),
  );
}
