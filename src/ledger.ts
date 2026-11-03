// Document review ledger (`avouch gate docs`). A rule of the tool, not of the format. Pure functions: they read only their
// arguments. The caller gives the sha256 function (hex digest of the UTF-8 text), so this file imports no runtime module.
import { isObj } from "./expr.js";
import { atxHeadings } from "./markdown.js";

export type Sha256 = (text: string) => string;
/** The key of a unit: the document, the titles from the top-level ancestor to the heading, and the occurrence (from 1) of that path. */
export interface UnitKey { doc: string; path: string[]; n: number }
/** A unit: the text from one heading line to the next heading line of any level (or from the start, heading null). */
export interface DocUnit extends UnitKey { heading: string | null; text: string; sha256: string; empty: boolean }
export interface LedgerDoc { doc: string; text: string }
export type LedgerUnitEntry = UnitKey & { sha256: string } & ({ claims: string[] } | { noClaim: string });
export interface LedgerOutlineEntry { doc: string; outline: string }
export type LedgerEntry = (LedgerUnitEntry | LedgerOutlineEntry) & { line: number };
/** `entry`: the ledger line of the unit as it is now, without `claims` and `noClaim`; the writer adds the decision. */
export interface LedgerUnitFailure extends UnitKey { sha256: string; firstLine: string; entry: string }
export interface LedgerResult {
  ok: boolean; // true iff the five failure lists below are all empty
  docs: number;
  units: number; // non-empty units
  emptyUnits: number;
  changed: LedgerUnitFailure[]; // FAIL: the current hash is not the hash of the entry
  unreviewed: LedgerUnitFailure[]; // FAIL: a non-empty unit without an entry
  stale: (UnitKey | { doc: string; outline: true })[]; // FAIL: an entry without a current non-empty unit, or an outline entry of a document that is not configured
  outline: { doc: string; sha256: string }[]; // FAIL: the outline entry is missing or has another hash (sha256: the current outline)
  dangling: (UnitKey & { pointer: string })[]; // FAIL: a pointer of claims that does not resolve in the ontology
}

const HEX = /^[0-9a-f]{64}$/;
const show = (x: unknown) => JSON.stringify(x) ?? String(x);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The text of a key: `<doc> <path as JSON> <n>`. */
export const unitKeyText = (k: UnitKey): string => `${k.doc} ${JSON.stringify(k.path)} ${k.n}`;

/**
 * The units of one document. The text is normalized first: the BOM is removed and CRLF becomes LF. Generated blocks
 * are not removed: their text is hashed as other text, so a change in it re-opens its unit (fail closed). Then the text
 * is cut at each ATX heading outside fences. The units keep their line breaks, so together they are exactly the
 * normalized text. The text before the first heading is the unit with heading null and path []; it is always the first unit.
 */
export function docUnits(d: LedgerDoc, sha256: Sha256): DocUnit[] {
  const text = d.text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const { heads } = atxHeadings(lines.map((l) => l.replace(/\n$/, "")));
  const starts = [{ line: 0, level: 0, title: null as string | null }, ...heads];
  const stack: { level: number; title: string }[] = [];
  const seen = new Map<string, number>();
  return starts.map((h, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const body = lines.slice(h.line, end);
    let path: string[] = [];
    if (h.title !== null) {
      while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
      const title = h.title.trim().replace(/\s+#+$/, "").trim();
      stack.push({ level: h.level, title });
      path = stack.map((s) => s.title);
    }
    const id = JSON.stringify(path);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const unitText = body.join("");
    const empty = body.slice(h.title === null ? 0 : 1).every((l) => l.trim() === "");
    return { doc: d.doc, path, n, heading: h.title, text: unitText, sha256: sha256(unitText), empty };
  });
}

/**
 * The outline of a document: the sha256 of the JSON text of the ordered list of `[path, n, heading line]` of all its
 * units, empty units included. The heading line is the exact first line (null for the text before the first heading),
 * so a change of level or of closing #s changes the outline, also for an empty unit.
 */
export const outlineHash = (units: DocUnit[], sha256: Sha256): string =>
  sha256(JSON.stringify(units.map((u) => [u.path, u.n, u.heading === null ? null : u.text.split("\n")[0]])));

/** Ledger order: doc, then the outline entry before the unit entries, then path element by element (a prefix first), then n. */
export function compareEntries(a: UnitKey | { doc: string; outline: unknown }, b: UnitKey | { doc: string; outline: unknown }): number {
  const d = cmpStr(a.doc, b.doc);
  if (d !== 0) return d;
  const ao = "outline" in a, bo = "outline" in b;
  if (ao || bo) return ao && bo ? 0 : ao ? -1 : 1;
  const pa = (a as UnitKey).path, pb = (b as UnitKey).path;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = cmpStr(pa[i], pb[i]);
    if (c !== 0) return c;
  }
  return pa.length !== pb.length ? pa.length - pb.length : (a as UnitKey).n - (b as UnitKey).n;
}

function checkKeys(o: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): void {
  for (const k of required) if (!Object.hasOwn(o, k)) throw new Error(`${k}: missing`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${k}: unknown key`);
}

// The shape of one entry line (not the header). Throws `<reason>` without the line prefix.
function entry(x: unknown): LedgerUnitEntry | LedgerOutlineEntry {
  if (!isObj(x)) throw new Error("not an object");
  if (typeof x.doc !== "string" || x.doc === "") throw new Error("doc: must be a non-empty string");
  if (Object.hasOwn(x, "outline")) {
    checkKeys(x, ["doc", "outline"], ["doc", "outline"]);
    if (typeof x.outline !== "string" || !HEX.test(x.outline)) throw new Error("outline: must be a sha256 in lower-case hex");
    return { doc: x.doc, outline: x.outline };
  }
  checkKeys(x, ["doc", "path", "n", "sha256"], ["doc", "path", "n", "sha256", "claims", "noClaim"]);
  if (!Array.isArray(x.path) || !x.path.every((t) => typeof t === "string")) throw new Error("path: must be an array of strings");
  if (typeof x.n !== "number" || !Number.isSafeInteger(x.n) || x.n < 1) throw new Error("n: must be an integer from 1");
  if (typeof x.sha256 !== "string" || !HEX.test(x.sha256)) throw new Error("sha256: must be a sha256 in lower-case hex");
  const key = { doc: x.doc, path: [...x.path] as string[], n: x.n, sha256: x.sha256 };
  if (Object.hasOwn(x, "claims") === Object.hasOwn(x, "noClaim")) throw new Error("must have exactly one of claims and noClaim");
  if (Object.hasOwn(x, "noClaim")) {
    if (typeof x.noClaim !== "string" || x.noClaim.trim() === "") throw new Error("noClaim: must be a non-empty reason");
    return { ...key, noClaim: x.noClaim };
  }
  const c = x.claims;
  if (!Array.isArray(c) || c.length === 0) throw new Error("claims: must be a non-empty array of JSON Pointers");
  c.forEach((p, i) => {
    if (p === "") throw new Error(`claims[${i}]: the root is not a claim`);
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`claims[${i}]: ${show(p)} is not a JSON Pointer that starts with /`);
    if (/~(?![01])/.test(p)) throw new Error(`claims[${i}]: ${show(p)}: ~ must be followed by 0 or 1`);
    const j = c.indexOf(p);
    if (j !== i) throw new Error(`claims[${i}]: duplicate of claims[${j}]`);
  });
  return { ...key, claims: [...c] as string[] };
}

/**
 * Checks the shape of the ledger lines (`{line, value}` from a JSON Lines file, blank lines skipped) and returns the
 * entries. The first line is `{"avouchLedger":1}`; the entries follow in ledger order, each key once.
 * Throws `<line>: <reason>` on the first error.
 */
export function parseLedger(lines: readonly { line: number; value: unknown }[]): LedgerEntry[] {
  const at = (line: number, reason: string): never => {
    throw new Error(`${line}: ${reason}`);
  };
  if (lines.length === 0) return at(1, 'missing header {"avouchLedger":1}');
  const [head, ...rest] = lines;
  const h = head.value;
  if (!isObj(h) || !Object.hasOwn(h, "avouchLedger")) return at(head.line, 'the first line must be {"avouchLedger":1}');
  if (h.avouchLedger !== 1) return at(head.line, `unknown version ${show(h.avouchLedger)}`);
  for (const k of Object.keys(h)) if (k !== "avouchLedger") at(head.line, `${k}: unknown key`);
  const out: LedgerEntry[] = [];
  for (const { line, value } of rest) {
    if (isObj(value) && Object.hasOwn(value, "avouchLedger")) at(line, "the header is allowed on the first line only");
    let e: LedgerUnitEntry | LedgerOutlineEntry;
    try {
      e = entry(value);
    } catch (error) {
      return at(line, (error as Error).message);
    }
    const prev = out.at(-1);
    if (prev !== undefined) {
      const c = compareEntries(prev, e);
      if (c === 0) at(line, `duplicate key of line ${prev.line}`);
      if (c > 0) at(line, `not sorted: this entry must come before line ${prev.line} (order: doc, its outline entry, path element by element, n)`);
    }
    out.push({ ...e, line });
  }
  return out;
}

/**
 * Resolves a JSON Pointer (RFC 6901: `~1` is `/`, `~0` is `~`; a `~` before another character, and the root "", do not resolve) in a value. One extension: on an array, a segment
 * selects the element whose `id` is the segment, or else the string element equal to it. A numeric index does not select.
 */
export function resolvePointer(value: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return false;
  let cur: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      const hit = cur.find((e) => isObj(e) && e.id === seg) ?? cur.find((e) => e === seg);
      if (hit === undefined) return false;
      cur = hit;
    } else if (isObj(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return false;
  }
  return true;
}

/** The gate: the current units of the documents against the ledger entries, and the claims against the ontology. */
export function verifyLedger(docs: readonly LedgerDoc[], entries: readonly LedgerEntry[], ontology: unknown, sha256: Sha256): LedgerResult {
  const r: LedgerResult = { ok: false, docs: docs.length, units: 0, emptyUnits: 0, changed: [], unreviewed: [], stale: [], outline: [], dangling: [] };
  const id = (k: UnitKey) => JSON.stringify([k.doc, k.path, k.n]);
  const fail = (u: DocUnit): LedgerUnitFailure => ({
    doc: u.doc, path: u.path, n: u.n, sha256: u.sha256, firstLine: u.text.split("\n")[0],
    entry: JSON.stringify({ doc: u.doc, path: u.path, n: u.n, sha256: u.sha256 }),
  });
  const current = new Map<string, DocUnit>();
  const outlines = new Map<string, string>();
  for (const d of docs) {
    const units = docUnits(d, sha256);
    outlines.set(d.doc, outlineHash(units, sha256));
    for (const u of units) {
      if (u.empty) r.emptyUnits++;
      else {
        r.units++;
        current.set(id(u), u);
      }
    }
  }
  const covered = new Set<string>();
  const outlineSeen = new Set<string>();
  for (const e of entries) {
    if ("outline" in e) {
      if (!outlines.has(e.doc)) r.stale.push({ doc: e.doc, outline: true });
      else {
        outlineSeen.add(e.doc);
        if (e.outline !== outlines.get(e.doc)) r.outline.push({ doc: e.doc, sha256: outlines.get(e.doc)! });
      }
      continue;
    }
    const key = { doc: e.doc, path: e.path, n: e.n };
    const u = current.get(id(key));
    if (u === undefined) r.stale.push(key);
    else {
      covered.add(id(key));
      if (u.sha256 !== e.sha256) r.changed.push(fail(u));
    }
    if ("claims" in e) for (const p of e.claims) if (!resolvePointer(ontology, p)) r.dangling.push({ ...key, pointer: p });
  }
  for (const [k, u] of current) if (!covered.has(k)) r.unreviewed.push(fail(u));
  for (const d of docs) if (!outlineSeen.has(d.doc)) r.outline.push({ doc: d.doc, sha256: outlines.get(d.doc)! });
  r.outline.sort((a, b) => cmpStr(a.doc, b.doc));
  for (const list of [r.changed, r.unreviewed, r.stale, r.dangling]) list.sort(compareEntries); // ledger order (stable: pointers stay in line order)
  r.ok = r.changed.length + r.unreviewed.length + r.stale.length + r.outline.length + r.dangling.length === 0;
  return r;
}
