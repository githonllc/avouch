// Built-in adapter for plain Markdown sources: document text in, SourceFacts out. It reads no file (the command line reads
// the configuration and the documents). The parse conventions are fixed here; docs/adapter-guide.md section 7 states them.
import { IDENT, RULES, type Diagnostic, type Fact, type FormatConfig, type PermissionRow, type RuleId, type RuleSwitch, type SectionLookup, type SourceFacts } from "./contract.js";

export interface MarkdownDoc { path: string; text: string }
export type MarkdownFactName = "storeCatalog" | "eventCatalog" | "contextMembers" | "permissions";
export interface MarkdownConfig { docs: string[]; facts: Partial<Record<MarkdownFactName, string>>; profile: FormatConfig }

const FACT_RULE: Record<MarkdownFactName, RuleId> = { storeCatalog: "R2", eventCatalog: "R8", contextMembers: "R5", permissions: "R10" };
const DEFAULT_DISABLED: Partial<Record<RuleId, string>> = {
  R3: "the Markdown adapter does not parse state machines or transition triggers",
  R7: "the Markdown adapter reads no execution evidence",
  R9: "the Markdown adapter does not parse scenarios",
};
const PROFILE_KEYS = ["actionIdPattern", "linkFieldPattern", "stateProperty", "crossContextMechanisms", "scenarioCoverage", "idempotencyDeclarationRequired", "evidenceRequired", "rules"];

// ------------------------------------------------------------------------------------------ configuration

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/** Parses the JSON configuration (`avouch.json`). Throws `<file>: <json path>: <problem>` on any error. */
export function parseMarkdownConfig(text: string, file: string): MarkdownConfig {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${file}: ${path}: ${problem}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fail("(root)", `not valid JSON: ${(error as Error).message}`);
  }
  if (!isObj(raw)) return fail("(root)", "must be an object");
  for (const k of Object.keys(raw)) if (!["docs", "facts", "profile"].includes(k)) fail(k, "unknown key");

  if (!Object.hasOwn(raw, "docs")) fail("docs", "missing");
  if (!Array.isArray(raw.docs) || raw.docs.length === 0) fail("docs", "must be a non-empty array of strings");
  const docs = raw.docs as unknown[];
  docs.forEach((d, i) => {
    if (!isStr(d)) fail(`docs[${i}]`, "must be a non-empty string");
    const j = docs.indexOf(d);
    if (j !== i) fail(`docs[${i}]`, `duplicate of docs[${j}]`);
  });

  const facts: Partial<Record<MarkdownFactName, string>> = {};
  if (Object.hasOwn(raw, "facts")) {
    if (!isObj(raw.facts)) fail("facts", "must be an object");
    for (const [k, v] of Object.entries(raw.facts as Record<string, unknown>)) {
      if (!Object.hasOwn(FACT_RULE, k)) fail(`facts.${k}`, "unknown key");
      if (!isStr(v)) fail(`facts.${k}`, "must be a non-empty string");
      facts[k as MarkdownFactName] = v as string;
    }
  }

  const p: Record<string, unknown> = {};
  if (Object.hasOwn(raw, "profile")) {
    if (!isObj(raw.profile)) fail("profile", "must be an object");
    for (const [k, v] of Object.entries(raw.profile as Record<string, unknown>)) {
      if (!PROFILE_KEYS.includes(k)) fail(`profile.${k}`, "unknown key");
      p[k] = v;
    }
  }
  const regex = (key: string, fallback: RegExp): RegExp => {
    if (!Object.hasOwn(p, key)) return fallback;
    if (!isStr(p[key])) return fail(`profile.${key}`, "must be a non-empty string");
    try {
      return new RegExp(p[key] as string);
    } catch (error) {
      return fail(`profile.${key}`, `invalid regular expression: ${(error as Error).message}`);
    }
  };
  const bool = (key: string): boolean | undefined => {
    if (!Object.hasOwn(p, key)) return undefined;
    if (typeof p[key] !== "boolean") fail(`profile.${key}`, "must be true or false");
    return p[key] as boolean;
  };
  if (Object.hasOwn(p, "stateProperty") && !isStr(p.stateProperty)) fail("profile.stateProperty", "must be a non-empty string");
  if (Object.hasOwn(p, "crossContextMechanisms") && (!Array.isArray(p.crossContextMechanisms) || !p.crossContextMechanisms.every(isStr)))
    fail("profile.crossContextMechanisms", "must be an array of non-empty strings");
  if (Object.hasOwn(p, "scenarioCoverage") && p.scenarioCoverage !== "printed" && p.scenarioCoverage !== "enforced") fail("profile.scenarioCoverage", 'must be "printed" or "enforced"');

  const rules = Object.fromEntries(RULES.map((r) => [r, DEFAULT_DISABLED[r] === undefined ? true : { disabled: DEFAULT_DISABLED[r] }])) as Record<RuleId, RuleSwitch>;
  if (Object.hasOwn(p, "rules")) {
    if (!isObj(p.rules)) fail("profile.rules", "must be an object");
    for (const [r, sw] of Object.entries(p.rules as Record<string, unknown>)) {
      if (!(RULES as readonly string[]).includes(r)) fail(`profile.rules.${r}`, "unknown rule");
      const ok = sw === true || (isObj(sw) && Object.keys(sw).length === 1 && isStr(sw.disabled));
      if (!ok) fail(`profile.rules.${r}`, 'must be true or {"disabled": "<reason>"}');
      rules[r as RuleId] = sw as RuleSwitch;
    }
  }

  const profile: FormatConfig = {
    actionIdPattern: regex("actionIdPattern", /^[A-Z][A-Z_]*$/),
    linkFieldPattern: regex("linkFieldPattern", /_id$/),
    stateProperty: Object.hasOwn(p, "stateProperty") ? (p.stateProperty as string) : "state",
    crossContextMechanisms: Object.hasOwn(p, "crossContextMechanisms") ? [...(p.crossContextMechanisms as string[])] : [],
    requiredSource: facts.permissions !== undefined ? { R10: facts.permissions } : {},
    rules,
  };
  if (Object.hasOwn(p, "scenarioCoverage")) profile.scenarioCoverage = p.scenarioCoverage as "printed" | "enforced";
  const idem = bool("idempotencyDeclarationRequired");
  if (idem !== undefined) profile.idempotencyDeclarationRequired = idem;
  const ev = bool("evidenceRequired");
  if (ev !== undefined) profile.evidenceRequired = ev;
  return { docs: docs as string[], facts, profile };
}

// ------------------------------------------------------------------------------------------ text structure

/**
 * Which lines are inside a ``` fence (opening and closing lines included), and the closed fenced blocks (info string and
 * body lines). A fence opens on a line that, after at most three leading spaces, starts with n >= 3 backticks; it closes
 * only on a line of >= n backticks (after at most three leading spaces) followed by nothing but white space.
 * `open`: the text ends inside a fence.
 */
function fences(lines: string[]): { inFence: boolean[]; open: boolean; blocks: { info: string; body: string[] }[] } {
  const inFence: boolean[] = [];
  const blocks: { info: string; body: string[] }[] = [];
  let n = 0, info = "", body: string[] = [];
  for (const line of lines) {
    if (n === 0) {
      const m = /^ {0,3}(`{3,})(.*)$/.exec(line);
      if (m) [n, info, body] = [m[1].length, m[2].trim(), []];
      inFence.push(m !== null);
    } else {
      const m = /^ {0,3}(`{3,})\s*$/.exec(line);
      if (m && m[1].length >= n) {
        n = 0;
        blocks.push({ info, body });
      } else body.push(line);
      inFence.push(true);
    }
  }
  return { inFence, open: n !== 0, blocks };
}

const BEGIN = /^<!-- BEGIN GENERATED: ([A-Za-z0-9._-]+)(.*) -->$/;
const END = /^<!-- END GENERATED: ([A-Za-z0-9._-]+) -->$/;

/**
 * The text without its generated blocks (marker lines included), and `breaks`: the indexes of the kept lines that follow a
 * removed block (a pipe table does not run across one). Throws on a malformed, nested, mismatched or unclosed marker.
 */
function withoutGenerated(text: string): { text: string; breaks: Set<number> } {
  const lines = text.split("\n");
  const { inFence } = fences(lines);
  const kept: string[] = [];
  const breaks = new Set<number>();
  let open: string | null = null, removed = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!inFence[i] && (t.startsWith("<!-- BEGIN GENERATED") || t.startsWith("<!-- END GENERATED"))) {
      const b = BEGIN.exec(t), e = END.exec(t);
      if (b) {
        if (open !== null) throw new Error(`line ${i + 1}: generated block ${b[1]} opens inside ${open}`);
        open = b[1];
      } else if (e) {
        if (open !== e[1]) throw new Error(`line ${i + 1}: generated block end ${e[1]} does not close ${open ?? "an open block"}`);
        open = null;
      } else throw new Error(`line ${i + 1}: malformed generated-block marker: ${t}`);
      removed = true;
      return;
    }
    if (open !== null) return;
    if (removed) breaks.add(kept.length);
    removed = false;
    kept.push(line);
  });
  if (open !== null) throw new Error(`generated block ${open} is not closed`);
  return { text: kept.join("\n"), breaks };
}

interface Heading { title: string; text: string; anchors: string[]; breaks: Set<number> } // breaks: relative to the heading line

/** ATX headings outside fences. Each heading has a short anchor (first word, one trailing `.` removed) and a full-title anchor. */
function headings(text: string, breaks: Set<number>): { list: Heading[]; fenceOpen: boolean } {
  const lines = text.split("\n");
  const { inFence, open } = fences(lines);
  const heads: { line: number; level: number; title: string }[] = [];
  lines.forEach((line, i) => {
    const m = inFence[i] ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (m) heads.push({ line: i, level: m[1].length, title: m[2] });
  });
  const list = heads.map((h, k) => {
    let end = lines.length;
    for (const n of heads.slice(k + 1))
      if (n.level <= h.level) {
        end = n.line;
        break;
      }
    const t = h.title.trim();
    const short = t.split(/\s+/)[0].replace(/\.$/, "");
    const full = t.replace(/\s+#+$/, "").trim();
    const own = new Set([...breaks].filter((b) => b > h.line && b < end).map((b) => b - h.line));
    return { title: h.title, text: lines.slice(h.line, end).join("\n"), anchors: [...new Set([short, full])].filter((a) => a !== ""), breaks: own };
  });
  return { list, fenceOpen: open };
}

/** Bodies of the closed top-level fenced blocks whose info string is exactly `text` (a fence inside another fence is body text). */
const textBlocks = (text: string): string[] =>
  fences(text.split("\n")).blocks.filter((b) => b.info === "text").map((b) => b.body.join("\n"));

/** Lines of the section text that are outside fences. */
const unfenced = (text: string): string[] => {
  const lines = text.split("\n");
  const { inFence } = fences(lines);
  return lines.filter((_, i) => !inFence[i]);
};

/**
 * A line split into code spans and plain text. A span opens with a run of n backticks and closes with the next run of
 * exactly n; a run without such a close is plain text. Outside a span, a backslash before a backtick or a pipe is an escape, and both characters stay as written.
 */
function spans(s: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let plain = "", i = 0;
  const run = (from: number) => {
    let k = from;
    while (s[k] === "`") k++;
    return k - from;
  };
  while (i < s.length) {
    if (s[i] === "\\" && (s[i + 1] === "`" || s[i + 1] === "|")) {
      plain += s.slice(i, i + 2);
      i += 2;
    } else if (s[i] === "`") {
      const n = run(i);
      let close = -1;
      for (let j = i + n; j < s.length && close < 0; ) {
        const m = run(j);
        if (m === n) close = j;
        j += Math.max(m, 1);
      }
      if (close < 0) plain += s.slice(i, i + n);
      else {
        if (plain !== "") out.push({ code: false, text: plain });
        plain = "";
        out.push({ code: true, text: s.slice(i, close + n) });
      }
      i = close < 0 ? i + n : close + n;
    } else plain += s[i++];
  }
  if (plain !== "") out.push({ code: false, text: plain });
  return out;
}

/** Contents of the code spans of a text (CommonMark: one leading and one trailing space are dropped when both are present). */
function codeContents(s: string): string[] {
  return spans(s)
    .filter((t) => t.code)
    .map((t) => {
      const n = t.text.length - t.text.replace(/^`+/, "").length;
      const c = t.text.slice(n, -n);
      return /^ .* $/s.test(c) && c.trim() !== "" ? c.slice(1, -1) : c;
    });
}

/** Cells of one pipe-table row: an escaped pipe and a `|` inside a code span are not separators; the leading and the optional trailing `|` are dropped. */
function cells(row: string): string[] {
  const s = row.trim();
  const out: string[] = [];
  let cur = "", endsWithSeparator = false;
  for (const t of spans(s)) {
    endsWithSeparator = false;
    if (t.code) {
      cur += t.text.replace(/\\\|/g, "|");
      continue;
    }
    for (let i = 0; i < t.text.length; i++) {
      endsWithSeparator = false;
      if (t.text[i] === "\\" && t.text[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (t.text[i] === "|") {
        out.push(cur);
        cur = "";
        endsWithSeparator = true;
      } else cur += t.text[i];
    }
  }
  if (!endsWithSeparator) out.push(cur);
  if (s.startsWith("|")) out.shift();
  return out.map((c) => c.trim());
}

const ALIGNMENT = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Pipe tables outside fences: runs of lines that start with `|`, alignment rows dropped; each table is its rows of cells.
 * A run ends at any other line, at a fence line and where a generated block was removed (`breaks`, section line indexes).
 */
function tables(h: Heading): string[][][] {
  const out: string[][][] = [];
  const lines = h.text.split("\n");
  const { inFence } = fences(lines);
  let cur: string[][] | null = null;
  lines.forEach((line, i) => {
    const row = !inFence[i] && line.startsWith("|");
    if (!row || h.breaks.has(i)) cur = null;
    if (!row) return;
    if (!cur) out.push((cur = []));
    if (!ALIGNMENT.test(line)) cur.push(cells(line));
  });
  return out;
}

// ------------------------------------------------------------------------------------------ facts

/** Facts from plain Markdown documents. Optional facts are present exactly when their anchor is configured. */
export function markdownFacts(docs: MarkdownDoc[], config: MarkdownConfig): SourceFacts {
  const diagnostics: Diagnostic[] = [];
  const texts: string[] = [];
  const index = new Map<string, Heading[]>();
  for (const d of docs) {
    let text = d.text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    let breaks = new Set<number>();
    try {
      ({ text, breaks } = withoutGenerated(text));
    } catch (error) {
      diagnostics.push({ rule: "R2", kind: "markdown_generated_blocks", key: `doc:${d.path}`, msg: `${d.path}: ${(error as Error).message}` });
    }
    texts.push(text);
    const { list, fenceOpen } = headings(text, breaks);
    if (fenceOpen) diagnostics.push({ rule: "R2", kind: "markdown_fence", key: `doc:${d.path}`, msg: `${d.path}: a fence is not closed at the end of the document` });
    for (const h of list) for (const a of h.anchors) index.set(a, [...(index.get(a) ?? []), h]);
  }
  const lookup = (anchor: string): Heading | "missing" | "ambiguous" => {
    const hs = index.get(anchor) ?? [];
    return hs.length === 0 ? "missing" : hs.length > 1 ? "ambiguous" : hs[0];
  };
  const section = (anchor: string): SectionLookup => {
    const h = lookup(anchor);
    return typeof h === "string" ? h : { title: h.title, text: h.text };
  };
  const f = <T>(anchor: string, value: T): Fact<T> => ({ value, source: { anchor } });
  const parseError = (name: MarkdownFactName, msg: string) => diagnostics.push({ rule: FACT_RULE[name], kind: "markdown_parse", key: `facts.${name}`, msg });
  // the section text of a configured fact, or null with a markdown_anchor diagnostic
  const configured = (name: MarkdownFactName, anchor: string): Heading | null => {
    const h = lookup(anchor);
    if (typeof h !== "string") return h;
    diagnostics.push({ rule: FACT_RULE[name], kind: "markdown_anchor", key: `facts.${name}`, msg: `anchor ${anchor} of facts.${name} is ${h}` });
    return null;
  };
  const catalog = (name: MarkdownFactName, text: string | null): Set<string> => {
    const set = new Set<string>();
    if (text === null) return set;
    const blocks = textBlocks(text);
    if (blocks.length !== 1) {
      parseError(name, `facts.${name} needs exactly one text code block in its section, found ${blocks.length}`);
      return set;
    }
    for (const line of blocks[0].split("\n")) {
      const t = line.split("//")[0].trim();
      if (t === "") continue;
      if (/\s/.test(t)) parseError(name, `facts.${name}: catalog line has white space: ${t}`);
      else set.add(t);
    }
    return set;
  };

  const facts: SourceFacts = {
    config: config.profile,
    diagnostics,
    info: [],
    section,
    containsTerm: (term) => texts.some((t) => IDENT(term).test(t)),
    fieldList: (anchor, objectType) => {
      const h = lookup(anchor);
      if (typeof h === "string") return null;
      const blocks = textBlocks(h.text).filter((b) => b.split("\n")[0].trim() === objectType);
      if (blocks.length !== 1) return null;
      const fields = new Map<string, { nullable: boolean }>();
      for (const line of blocks[0].split("\n")) {
        const m = /^- (.+?)(?:\s*\/\/.*)?$/.exec(line);
        if (m)
          for (const part of m[1].split(" / ")) {
            const t = part.trim();
            const name = t.replace(/\?$/, "");
            fields.set(name, { nullable: t.endsWith("?") || (fields.get(name)?.nullable ?? false) });
          }
      }
      return f(anchor, fields);
    },
  };

  const a = config.facts;
  if (a.storeCatalog !== undefined) facts.storeCatalog = f(a.storeCatalog, catalog("storeCatalog", configured("storeCatalog", a.storeCatalog)?.text ?? null));
  if (a.eventCatalog !== undefined) facts.eventCatalog = f(a.eventCatalog, catalog("eventCatalog", configured("eventCatalog", a.eventCatalog)?.text ?? null));
  if (a.contextMembers !== undefined) {
    const anchor = a.contextMembers;
    const h = configured("contextMembers", anchor);
    const members = new Map<string, Fact<Set<string>>>();
    if (h !== null) {
      for (const line of unfenced(h.text)) {
        const m = /^- ([^:]+): (.+)$/.exec(line);
        if (!m) continue;
        const context = m[1].trim();
        if (members.has(context)) parseError("contextMembers", `facts.contextMembers: context ${context} is listed more than once`);
        else members.set(context, f(anchor, new Set(m[2].split(",").map((x) => x.trim()).filter((x) => x !== ""))));
      }
      if (members.size === 0) parseError("contextMembers", "facts.contextMembers: the section has no `- <context>: <members>` line");
    }
    facts.contextMembers = members;
  }
  if (a.permissions !== undefined) {
    const anchor = a.permissions;
    const h = configured("permissions", anchor);
    const rows = new Map<string, PermissionRow>();
    if (h !== null) {
      const ts = tables(h);
      if (ts.length !== 1) parseError("permissions", `facts.permissions needs exactly one pipe table in its section, found ${ts.length}`);
      else if (ts[0].length === 0 || ts[0][0].length !== 2) parseError("permissions", `facts.permissions: the table header has ${ts[0][0]?.length ?? 0} columns, expected 2`);
      else
        for (const row of ts[0].slice(1)) {
          if (row.length !== 2) {
            parseError("permissions", `facts.permissions: row has ${row.length} columns, expected 2: ${row.join(" | ")}`);
            continue;
          }
          const keys = new Set(codeContents(row[1]));
          for (const name of row[0].split(",").map((x) => x.trim()).filter((x) => x !== "")) {
            if (rows.has(name)) parseError("permissions", `facts.permissions: row ${name} is listed more than once; the first row is kept`);
            else rows.set(name, { keys, text: row[1] });
          }
        }
    }
    facts.permissions = { catalog: f(anchor, catalog("permissions", h?.text ?? null)), rows: f(anchor, rows), quoteNamesKey: (q, k) => q.includes("`" + k + "`") };
  }
  return facts;
}
