// JSON-pointer patch used by mutation tests (moved from ontology.test.ts). No imports.
export type Op = { op: "remove" | "replace" | "add"; path: string; value?: unknown };
export function applyPatch(doc: any, ops: Op[]): any {
  const out = structuredClone(doc);
  for (const o of ops) {
    const parts = o.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = parts.pop()!;
    let cur = out;
    for (const k of parts) {
      if (cur === null || typeof cur !== "object" || !(k in cur)) throw new Error(`patch path not found: ${o.path}`);
      cur = cur[k];
    }
    if (Array.isArray(cur)) {
      if (o.op === "add" && last === "-") cur.push(o.value);
      else {
        const i = Number(last);
        if (!Number.isInteger(i) || i < 0 || i >= cur.length + (o.op === "add" ? 1 : 0)) throw new Error(`bad array index: ${o.path}`);
        if (o.op === "remove") cur.splice(i, 1);
        else if (o.op === "replace") cur[i] = o.value;
        else cur.splice(i, 0, o.value);
      }
    } else {
      if (o.op !== "add" && !(last in cur)) throw new Error(`patch path not found: ${o.path}`);
      if (o.op === "remove") delete cur[last];
      else cur[last] = o.value;
    }
  }
  return out;
}
