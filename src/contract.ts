// Fact contract between a project adapter and the format-level checker. No imports.
export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12";
export const RULES: readonly RuleId[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"];

/** A name as a whole identifier: not preceded or followed by a letter, a digit or `_`. */
export const IDENT = (s: string) => new RegExp(`(?<![A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);

export interface Source { anchor: string; locator?: string }
export interface Fact<T> { value: T; source: Source }
/** Adapter finding (parse error, duplicate row, harness error). Reported and waived exactly like a violation. */
export interface Diagnostic { rule: RuleId; kind: string; key: string; msg: string }
export interface Violation { rule: string; kind: string; key: string; msg: string }
export interface Report { violations: Violation[]; waived: Violation[]; info: string[] }

export type SectionLookup = { title: string; text: string } | "missing" | "ambiguous";
/** nodes = all states; initial = targets of initial pseudo-edges (exactly one expected, checked by R3); edges = "FROM->TO". */
export interface StateMachineFact { nodes: string[]; initial: string[]; edges: string[] }
/** Stable row identity supplied by the adapter (for example a SQLite rowid); never a key column that an update may change. */
export type RowId = string | number;
/** Net committed change of one store, row by row: an insert keeps its after image, an update its changed columns, a delete its before image. */
export interface StoreDelta {
  inserted: { row: RowId; after: Record<string, unknown> }[];
  updated: { row: RowId; changes: Record<string, { before: unknown; after: unknown }> }[];
  deleted: { row: RowId; before: Record<string, unknown> }[];
}
/** Inputs the evaluation of one invocation depends on. Recorded only; no rule reads them yet. */
export interface EvaluationInputs { bindings: unknown; actor: unknown; scope: unknown; now: unknown }
/** Committed net change of one invocation: changed stores and the event types written. */
export interface InvocationDelta { stores: Record<string, StoreDelta>; events: string[] }
/**
 * One invocation of an operation, with an id that the harness generates. Plain records and arrays (no Map or Set), so the
 * evidence serializes as JSON. Aggregates (changed stores, committed count) are derived by the checker, never stored.
 * `delta` is non-null iff the outcome is committed (a rejected record has `delta: null`, not an omitted key); the checker
 * reports any record that breaks this type (SPEC section 4) as an R7 info diagnostic and never throws on it.
 */
export type Invocation = {
  id: string;
  rolledBackAttempts: number; // counted only; rolled-back attempts are not in delta
  snapshot: string | null; // reference to the snapshot taken before the invocation
  inputs: EvaluationInputs;
  disposition?: string; // disposition the runtime reported, if any
} & ({ outcome: "committed"; delta: InvocationDelta } | { outcome: "rejected"; delta: null }); // rejected: every attempt rolled back
export interface PermissionRow { keys: Set<string>; text: string } // text: the row's key cell; permission cites must be substrings of it
export interface Permissions {
  catalog: Fact<Set<string>>;
  rows: Fact<Map<string, PermissionRow>>; // row name (an action id or a declared non-action name) -> row
  quoteNamesKey(quote: string, key: string): boolean; // does the quote name the key in the source's key syntax
}
export type RuleSwitch = true | { disabled: string };
export interface FormatConfig {
  actionIdPattern: RegExp;
  linkFieldPattern: RegExp;
  stateProperty: string;
  crossContextMechanisms: string[];
  requiredSource: Partial<Record<RuleId, string>>; // R10: the anchor every permission cite must name
  scenarioCoverage?: "printed" | "enforced"; // R9: default "printed"
  rules: Record<RuleId, RuleSwitch>;
  idempotencyDeclarationRequired?: boolean; // R1: an action without idempotencyKey fails idempotency_undeclared; default false
  evidenceRequired?: boolean; // R7: an action without `evidence` fails `evidence_missing`; default false
}
export interface SourceFacts {
  config: FormatConfig;
  diagnostics: Diagnostic[];
  info: string[];
  section(anchor: string): SectionLookup;
  containsTerm(term: string): boolean;
  fieldList(anchor: string, objectType: string): Fact<Map<string, { nullable: boolean }>> | null; // field name -> nullable (a trailing ? in the list); null: section missing/ambiguous, or not exactly one field list
  storeCatalog?: Fact<Set<string>>; // R2
  stateMachines?: Map<string, Fact<StateMachineFact | null>>; // R3: objectType -> machine at its authoritative anchor
  transitionTriggers?: Map<string, Map<string, Fact<Set<string>>>>; // R3: objectType -> "FROM->TO" -> action ids
  contextMembers?: Map<string, Fact<Set<string>>>; // R5: context -> member names
  eventCatalog?: Fact<Set<string>>; // R8
  scenarios?: { ids: Set<string>; cites: Map<string, Set<string>> }; // R9: scenario id -> cited action ids
  permissions?: Permissions; // R10
  evidence?: Map<string, Invocation[]>; // R1 (id validity), R6 (none_but_written), R7: evidence id -> invocations
}
