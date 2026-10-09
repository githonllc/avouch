# Avouch v1: specification

Avouch is an ontology format whose every claim cites its source. Status: experimental draft. It is not a standard.

Format version: `formatVersion: 1` in the ontology file; `v1` in the schema `$id` (`https://w3id.org/avouch/v1/schema.json`).

Identifiers: every Avouch identifier is under `https://w3id.org/avouch/`, a permanent redirect service. Write only these identifiers in files and exports. The schema `$id` is `https://w3id.org/avouch/v1/schema.json`, and the vocabulary namespace is `https://w3id.org/avouch/v1/vocab#`. `https://avouch.dev/` is where the documents are hosted. It is a location, never an identifier.

## 1. Three layers

```
 (1) format layer            this package             schema, fact contract, rules R1-R12
 (2) project profile+adapter the project's own code   config, rule switches, parsers of the project's sources
 (3) ontology instance       <project>.ontology.yaml  the project's objects, links, actions
```

The format layer never reads a source document. The package also ships a generic adapter for plain Markdown sources, `src/markdown.ts`; it belongs to layer (2), takes document texts rather than file paths, and the checker does not import it (conventions: `docs/adapter-guide.md` section 7). The adapter reads the sources and returns `SourceFacts` (section 4). The checker compares the ontology (3) with those facts. Parse conventions (headings, table headers, anchor syntax) stay in adapter code, not in configuration.

An ontology file conforms to the format when both are true: it validates against `ontology.schema.json`, and the checker reports no violation that is not waived. The two checks do not overlap: the schema rejects unknown keys (`additionalProperties: false`), empty names (`propertyNames: {minLength: 1}` on every map keyed by a name) and wrong value types; R1 checks required shape, references and ids, and does not look for unknown keys.

### Admission criteria for the format layer

Only generic needs go into the format. A special-case need stays in the project profile or the ontology instance. A new concept, field or rule enters the format only when all three are true:

1. It is a modelling pattern that applies across projects, not the habit of one project.
2. The existing constructs cannot express it, or can express it only by a workaround that loses a check.
3. Its meaning holds no project-specific values. Such values go into the profile configuration (for example `config.crossContextMechanisms`).

Example: objects shared by several contexts (a shared kernel) are a cross-project pattern. The format already expresses them: the shared objects get their own context, and actions that write them declare `crossContext`. An exemption such as "writes to shared objects need no declaration" fails criteria 2 and 3, so it is not in the format.

## 2. Concepts

A key is foundation when Palantir Foundry has the same concept (names follow https://www.palantir.com/docs/foundry/ontology/overview/ and the pages for each type). A key is extension when Palantir has no analog; the rule that uses it is named.

The definitions quoted in the "Palantir analog" column are short quotations from the Palantir Foundry documentation. They belong to their authors and are not covered by the license of this project.

| Key | Class | Palantir analog | Note |
|---|---|---|---|
| `objectTypes` | foundation | object type: "the schema definition of a real-world entity or event" | no primary key or title key |
| `objectTypes.<O>.datasource` | foundation | backing datasource | R7 maps written stores back to objects |
| `properties` | foundation | property: "the schema definition of a characteristic of a real-world entity or event" | |
| `properties.<p>.class` | extension | none | canonical / derived / policy / unknown; R4 |
| `properties.<p>.type` | foundation | property base type | value type (`enum timestamp duration date timezone id integer boolean`, `{ref: <Object>}`, `{set: <type>}`); needed when an expression reads the property; needs a cite (R2 `type_without_provenance`) |
| `properties.<p>.materializedFrom` | extension | none | stored property materialized with its inputs; R11. Not a Palantir derived property (computed at runtime, read-only) |
| `derivedProperties` | foundation | derived property: "calculated at runtime based on the values of other properties or links" | unstored predicates |
| `derivedProperties.<d>.expr` / `cite` / `type` | foundation | derived property definition | the definition as an expression over `self` (instead of `reads`), its source text and its declared type; a predicate expression has type `boolean`; without `expr` the derived property is undefined for evaluation; R1, R2, R4, R12 |
| `linkTypes` | foundation | link type: "the schema definition of a relationship between two object types" | `via` / `table` map to a foreign key or a many-to-many datasource; `create_rule` is an extension (R5) |
| `actionTypes` | foundation | action type: "the schema definition of a set of changes or edits to objects, property values, and links that a user can take at once" | |
| `actionTypes.<A>.parameters` | foundation | action parameter: "Parameters are the inputs of an action type." | name → `{cite, type?, optional?, values?}`; read by a condition as `{param}` or, in an expression, `{ref}`; `type` is needed when an expression reads it; `optional: true` lets the caller omit it; `values` (only with `type: enum`) is the value domain of the parameter; R1, R2 |
| `conditions` | foundation + constraint | submission criteria: "the conditions that determine whether an action can be submitted"; Palantir submission criteria ≈ the rows whose disposition class is `rejected` | named Boolean claims `{id, expr \| unspecified, reads?, reads_unspecified?, cites[{cite}], scenarios?}`: `expr` is the claim as an expression (section 9); `unspecified` says it is not written as one, and `reads` may then list what it reads (properties, parameters `{param, values?}`, the caller `{actor: id}` / `{actor: keys}`); R1, R4, R12 |
| `decision` | extension | none | decision table `{hitPolicy: first, order?: {cite}, rows: [{when: {passes \| fails: <condition>}, result, cites, next?}], otherwise?: {result, cites, next?}}`; `next` is `{actions}`, `{external, cite}` or `{unspecified}`; R1, R12 |
| `edits` / `creates` | foundation | action rules: modify / create object | |
| `link_effects` | foundation + constraint | action rules: create / delete link | every incident link needs an entry, including `none` / `unspecified` (R6 sweep) |
| `emits` | extension | none (Palantir side effects are notifications / webhooks after submission) | events written in the same operation; R7, R8 |
| `permission` | extension | roles / submission criteria on the current user are approximate. Forms: `unknown`, `{keys, cite, …}`, `{none, cite}` (optionally with `principals`), `{any_of: [keys-form, …]}` (OR of keys-forms, at least 2) | R1, R10 |
| `permission` … `principals` | extension | none | optional on a keys-form, an `any_of` alternative or the `{none}` form: `{kinds: [<actor kind>, …], cite}`; an actor of another kind is denied; the cite is checked by R2, not by R10; R1, R2 |
| `scope` | extension | none | optional tenant scope `{by, global?: [{type, cite}], root?: {type, cite}, cite}`; unlisted object types are tenant types; `cite` supports `by` only; R1, R2, R6 |
| `dispositions` | extension | none | optional result vocabulary `{<ID>: {class: rejected \| recorded \| pending \| applied, cite}}`; decision rows name these ids; R1, R2 |
| `stateMachines` | extension | none | R3 |
| `idempotencyKey` | extension | none | `{required, cite}`: whether the caller must supply an idempotency key. Absent = unspecified (not `false`). A missing key on a `required: true` action is rejected at request shape, before `decide` (so before its shape step), permission and the envelope; it is not an invocation result of `decide`, gives no receipt and is not reconciled. Never derived from effects. R1, R2 |
| `evidence` | extension | none | id of the executed evidence, resolved by the evidence adapter; R1, R6, R7 |
| `cite` / `knownSourceGaps` | extension | none | provenance and waivers; R2 |
| `crossContext`, `infrastructureStores`, `outOfScopeObjectTypes` | extension | none | optional; `crossContext` is `{via, cite}` (legal `via` values come from the project config) or `{unspecified, cite}` when the source does not say the mechanism (R5 `mechanism_unspecified`, waivable) |

Keys that keep their original names (not in the Palantir mapping): `permission_rows_not_commands`, `link_effects`, `non_link_fields`, `edit_cites`, `doc_term`, `create_rule`, and the link key `table`.

## 3. Field reference

The schema `ontology.schema.json` is the field reference: each `description` states whether the field is foundation or extension, and which rule enforces what. The description text and this section are the same source.

## 4. Fact contract

The contract is `src/contract.ts` (types `SourceFacts`, `Fact`, `Diagnostic`, `FormatConfig`, `Invocation`, `StoreDelta`, `RowId`, `EvaluationInputs`, `StateMachineFact`, `Permissions`). Every fact carries its `source` (`anchor`, optional `locator`).

No fact that an adapter returns may come from text generated from the ontology; the adapter excludes such text before it extracts any fact. The provenance of a claim is its `cite`, or a fact that the adapter returns with its source location.

Evidence is a list of invocation records per evidence id (`Invocation`). One record is one invocation of the operation:

- `id`: generated by the harness; it is not the idempotency key of the request.
- `outcome`: `committed`, or `rejected` when every attempt rolled back.
- `snapshot`: a reference to the snapshot taken before the invocation, or `null`.
- `inputs`: the evaluation inputs `bindings`, `actor`, `scope` and `now`.
- `delta`: the committed net change; `null` (present, not omitted) when the outcome is `rejected`. Per store, row by row, with a stable row identity that the adapter supplies (for example a SQLite rowid; not a key column, because an update can change a key column). The row identity must stay the same across an UPDATE; a replace-style write (for example `INSERT OR REPLACE`) gives the row a new identity and shows up as a delete and an insert. A row identity must not be reused within one invocation: a store that gives a deleted row's identity to a new row in the same invocation (for example a SQLite rowid table without `AUTOINCREMENT`, where the row with the largest rowid is deleted and a row is then inserted) makes the delete and the insert show up as an update. An insert gives the row and its after image; an update gives the row and the before and after values of each changed column; a delete gives the row and its before image. `events` lists the event types written.
- `disposition`: optional; the disposition that the runtime reported.
- `rolledBackAttempts`: a non-negative integer; rolled-back attempts are only counted (printed in `info`); they are never in `delta`.

Records are runtime data (for example parsed JSON), so the checker checks their shape. A well-formed record is a mapping with a non-empty string `id`, a non-negative integer `rolledBackAttempts`, and either `outcome: committed` with a `delta` whose `stores` is a mapping of store deltas (lists `inserted`, `updated` and `deleted`; each entry has a string or number `row` and an `after`, `changes` or `before` mapping) and whose `events` is a list of strings, or `outcome: rejected` with `delta: null`. Any other record (including a list entry that is not a mapping) counts as neither committed nor rejected, adds nothing to the observed changes or the attempt count, and is reported as an info diagnostic (not a violation): `R7 evidence <evidence id>: malformed invocation <invocation id>: <reasons>`, where the id is `[<list index>]` when the record has no string `id` (an adapter should always set an `id`). An invocation list that is not a list counts as empty and is reported once the same way (id `list`). The check never throws.

Aggregates (changed stores, committed count) are derived by the checker from the records; the adapter does not store them. How the adapter takes snapshots, and its size and time budget, belong to the adapter, not to this format.

Three states of a fact:

| State | Meaning |
|---|---|
| field is `undefined` | the adapter does not provide this fact. If a rule that needs it is enabled: one violation, kind `fact_missing`, key `facts.<field>`; the checks that depend on the fact are skipped |
| field present | the adapter parsed as much as it could; parse failures are reported as diagnostics; the value holds only what parsed (it may be empty). The checker compares as usual (fail closed) |
| exception | an entry of `stateMachines` may be `null`: the machine did not parse, a diagnostic was reported, and the checker skips the graph comparison for that object |

The adapter may read the ontology instance (for example to list action ids in a trigger cell). Therefore facts are built per ontology, including per mutation. The returned `SourceFacts` is a plain object literal whose functions are own properties, so a test can drop one fact with `{ ...facts, eventCatalog: undefined }`.

`diagnostics` are adapter findings (parse errors, duplicate rows, harness errors). For example, the evidence adapter reports an observed write that it cannot attribute to exactly one evidence id as an R7 diagnostic. They are reported and waived exactly like violations. `info` lines are printed.

## 5. Rules R1-R12

| Rule | Checks | Facts used | Guarantee | Not guaranteed |
|---|---|---|---|---|
| R1 | shape, references resolve (a `{param}` read names a parameter of its action; `actor` is `id` or `keys`), ids unique, `formatVersion`, evidence ids exist; expressions type-check (section 9; the properties, parameters and derived properties they read declare `type`; `self` only in derived expressions; quantifier variables do not reuse reserved or bound names; set literals are non-empty with one element type), derived properties have exactly one of `expr` / `reads` and form no cycle, a derived `expr` has `type` and `cite`; a condition has exactly one of `expr` / `unspecified`, `reads` only with `unspecified`; duplicate condition ids are R1 (implementation decision: each entry with an `expr` is type-checked, but every entry with that id takes its type error, R4 reads and literals, and the R12 derived-property part from the last entry with that id that has an `expr`; the static UNKNOWN analysis also uses that last entry, while `decide` evaluates the first entry with that id); `scope` types are declared object types, each listed once; disposition ids are not invocation results; decision rows name a condition of the action and a disposition, only `pending` results have `next` (and must), `next.actions` are declared actions; `principals` is `{kinds: [distinct], cite}`; `idempotencyKey` is `{required: boolean, cite}`; a parameter with `values` has `type: enum` and a non-empty list of distinct non-empty strings, and a string literal compared with that parameter (`eq` / `neq` with `{ref: <name>}` on the other side, or every element of the set literal in `in [{ref: <name>}, {lit: [..]}]`) must be one of its `values` (else a type error); with `config.idempotencyDeclarationRequired: true` (default `false`) an action without `idempotencyKey` fails `idempotency_undeclared` (key `<ID>`) | `config.actionIdPattern`, `config.stateProperty`, `evidence` keys, `config.idempotencyDeclarationRequired` | structure is well-formed | that an expression means what its cite says |
| R2 | anchors unique, quotes verbatim (also under `derivedProperties`, `scope` and `dispositions`), properties are fields, names in the store catalog, parameter names appear in their quote (`parameter_not_in_quote`), and so does each of a parameter's `values` (`parameter_value_not_in_quote`, key `<ID>:<name>:<value>`); with `scope`: each tenant type's field list has `<by>` (`scope_field_missing`, key `<Object>.<by>`), no global type's field list has it (`scope_field_present`), `<by>` is in the scope quote (`scope_by_not_in_quote`, key `scope`); each disposition id is in its own quote (`disposition_not_in_quote`, key `dispositions.<ID>`); a declared `type` has a cite (`type_without_provenance`, key `<Object>.<prop>` or `derivedProperties.<id>`; a derived property with `expr` and no cite is R1 only) | `section`, `containsTerm`, `fieldList`, `storeCatalog` | quotes exist in the source | that a quote supports the claim |
| R3 | graph equality, terminal states, reachability, `by` = triggers, `by` iff the action edits the state property | `stateMachines`, `transitionTriggers`, `config.stateProperty` | ontology matches the source machine | trigger-cell conditions; objects without a machine in the source |
| R4 | conditions read only canonical and policy properties, for an expression also through the derived properties it reaches (parameter and actor reads are request inputs, not state, and are not classified; a derived property without `expr` is not expanded; a hand-written `reads` entry that names a derived property is expanded through its `reads`, or, when it has an `expr`, through the properties that expression reads, as for an expression condition); a non-canonical property passes when every read compares it by `eq` / `neq` with a literal in its `canonical_values`; canonical values and the values of a parameter read appear in their quote (`parameter_value_unsupported`); each literal of an expression appears in one of its condition's quotes, or in the derived property's quote (`literal_unsupported`, key `<ID>:<condition id>:<value>` or `derivedProperties.<id>:<value>`) | none | the property reads of conditions are canonical or policy facts; literals are not invented | that `reads` is complete; that an expression's logic matches its cite |
| R5 | object membership, cross-context declaration (`via` or `unspecified`), `create_rule`, entity coverage | `contextMembers`, `config.crossContextMechanisms` | object ownership matches the source | the content of the mechanism |
| R6 | link sweep, link catalog complete (with `scope`, the `<by>` field of a tenant type counts as declared and must not be in `non_link_fields`: `non_link_field_stray`), `none_but_written` | `fieldList`, `config.linkFieldPattern`, `evidence` | link effects are declared completely | that an effect text is right |
| R7 | observed writes are declared; events are in `emits`; changed columns are declared (`column_undeclared`, key `<ID>:<Object>.<prop>`); declared effects are witnessed (`effect_unwitnessed`); with `config.evidenceRequired: true` (default `false`) an action without `evidence` fails `evidence_missing` (key `<ID>`) | `evidence`, `config.evidenceRequired` | every store changed by a committed invocation is in the touched objects' `datasource`, a pure link table with an `effect`, or `infrastructureStores`; every observed event is in `emits`; every column changed on an existing row of a touched object's `datasource` is, for each touched object of that store, a property of a resolvable `edits` entry of that same object (objects may share a store; a column that one object declares is still reported for each other touched object of the store that does not declare it); every resolvable `edits` entry (resolved as R1 resolves it; an unresolvable entry is R1 only) was changed on an existing row (key `<ID>:<Object>.<prop>`), every `creates` object had a row inserted (key `<ID>:creates:<Object>`) and every pure link table with an `effect` had a row inserted or deleted (key `<ID>:link:<link id>`) by at least one committed invocation | actions without evidence (unless `evidenceRequired`); that a not yet witnessed effect is unreachable; atomicity, which refers to the committed effect (one invocation may have several attempts) and which the project profile or evidence adapter must enforce |
| R8 | emitted events are in the catalog | `eventCatalog` | | |
| R9 | scenario cross references | `scenarios` | every action is cited; with `config.scenarioCoverage: "enforced"` (default `"printed"`, coverage only printed) every condition without `scenarios` fails `criterion_uncovered` (key `<ID>:<condition id>`) and every non-`none`, non-`unspecified` link effect without `scenarios` fails `effect_uncovered` (key `<ID>:<link id>`); `unspecified` effects are not reported again, R6 reports them | with `printed`, that scenarios cover every condition; that a listed scenario supports the claim |
| R10 | permission key sets equal the source rows (for `any_of`: the union over alternatives of keys ∪ conditional_keys; each alternative's cite must also name its own keys); cites name the required source | `permissions`, `config.requiredSource.R10` | keys match the source | |
| R11 | an action that edits an input lists the materialized property | none | declaration is complete | same-operation atomicity of the committed effect (one invocation may have several attempts), which the evidence adapter guarantees |
| R12 | decision tables, all waivable: an action with conditions has a `decision` (`decision_table_missing`, key `<ID>`); a table has `otherwise` (`otherwise_missing`); a row does not use a condition without expression, or one that reaches a derived property without expression (`condition_unspecified`, key `<ID>:<condition id>`) (implementation decision: like the R4 and literal checks, the derived-property part is computed only for conditions whose expression passes the R1 type check); rows with different results have `order` (`row_order_uncited`); for rows `i < j` with different results whose position cites are in one section, the position of `i` comes first (`row_order_mismatch`, key `<ID>:rows.<i>:rows.<j>`, once per pair; implementation decision, since facts carry no order across sections: a row's position cite is in the section of the first listed cite whose quote names its result, and its position is the earliest such quote in that section). A row whose position-cite section is `missing` or `ambiguous` has no position and is not compared. Rows whose position cites are in different sections are not compared, even if they also cite a shared section; ordering across sections relies on `decision.order` and scenarios with overlapping inputs; each row names its result in a cite quote (`result_unsupported`, key `<ID>:rows.<i>` or `<ID>:otherwise`); `next: {unspecified}` is reported (`next_unspecified`); a row `passes(c)` where c may be UNKNOWN, no earlier row is `fails(c)`, and a later row up to the first later `fails(c)` row (inclusive), or `otherwise` when there is no such row, has class `applied` or `pending` (`unsafe_fallthrough`, key `<ID>:rows.<i>`); the body of an `exists` / `none` / `all` may be UNKNOWN (`quantifier_absorbs_unknown`, key `<ID>:<condition id>:<path>` or `derivedProperties.<id>:<path>`, path as in type errors, for example `$.and[1].none`); both see section 9, Static UNKNOWN analysis | `section`, `fieldList` | every row has a source for its result and, within one section, for its place | that rows do not overlap; that the order cite covers the whole table |

## 6. Rule switches

`config.rules` must have an entry for every rule.

- A missing entry: one violation `{ rule, kind: "rule_not_configured", key: "config.rules.<R>" }`; the rule runs as enabled.
- `{ disabled: "<reason>" }`: violations of that rule and diagnostics with that rule are dropped; `info` gets `rule <R> disabled: <reason>`; the facts the rule needs are not checked for presence.
- `true`: the rule runs. For each fact the rule needs, `undefined` gives `fact_missing` (section 4):

| Rule | Needed optional fact | Checks skipped when it is missing |
|---|---|---|
| R1, R4, R11, R12 | none | none |
| R2 | `storeCatalog` | store catalog membership |
| R3 | `stateMachines` | authoritative anchor check; graph comparison |
| R3 | `transitionTriggers` | trigger binding checks |
| R5 | `contextMembers` | membership and entity coverage |
| R6 | `evidence` | `none_but_written` |
| R7 | `evidence` | all except `evidence_missing` |
| R8 | `eventCatalog` | catalog membership |
| R9 | `scenarios` | all |
| R10 | `permissions` | all |

The table lists only the optional facts. Every rule may also read the required facts `section`, `containsTerm` and `fieldList`. When an adapter cannot answer them (`section` gives `missing` or `ambiguous`, `fieldList` gives `null`), the reading rule degrades as written in its own row: for example, R12 compares no pair of rows for `row_order_mismatch`, and the UNKNOWN analysis treats every field of that object as nullable.

## 7. Waivers

`knownSourceGaps` entries waive a violation when `rule`, `kind` and `key` all match. Waived items are printed. A waiver that matches nothing fails under its own rule with kind `stale_waiver`. Waivers treat violations and adapter diagnostics alike.

## 8. Versions

The version is in two places: `v1` in the schema `$id`, and `formatVersion: 1` in the ontology file (R1 fails on any other value). A change that breaks existing ontologies raises both. A change that rejects only files without meaning (for example an empty name) is not a break. Adding the `permission.any_of` form is additive: existing files stay valid, so `formatVersion` stays 1. Adding `parameters` and the parameter and actor reads of the submission criteria (since renamed `conditions`) is additive: existing files stay valid, so `formatVersion` stays 1. Adding `values` on enum parameters is additive; `formatVersion` stays 1.
During 0.x the v1 draft changes in place (`formatVersion` 1, `$id` v1); the rule above applies from the 1.0 semantic freeze.

## 9. Decision semantics

Stage 1A; runtime consistency is Stage 1B. Code: `src/expr.ts` (AST, types, static check) and `src/evaluate.ts` (`evalValue`, `evalPredicate`, `decide`). The schema carries these keys (section 1); this section defines their meaning. Examples use a toy library: `Branch` (root), `Person` (global), `Member`, `Book`, `Loan` (tenant, `by: branch_id`).

### Expressions and two-level evaluation

Every node is a single-key map. The reserved names `now`, `actor` and `self` are exported as `RESERVED_NAMES`. The node set is fixed (`EXPR_NODES`):

| Level | Nodes | Result |
|---|---|---|
| value | `{ref: path}`, `{lit: v}`, `{plus: [t, d]}`, `{dateIn: [t, tz]}`, `{derived: {id, of: {ref: x}}}` | a typed value or null (`evalValue`) |
| predicate | `eq` `neq` `lt` `lte` `gt` `gte` `[a, b]`; `and` `or` `[p, q, …]` (2 or more); `not` `[p]`; `in` `[element, set]`; `subsetOf` `[set, set]`; `isNull` `isNotNull` `[a]`; `exists` `none` `all` `{as, in: <nav>, where?}` | T, F or U (`evalPredicate`); a value node of type `boolean` is also a predicate |
| navigation | `{nav: {from: {ref: x}, link, dir: forward \| reverse}}` | a set of objects; only as the `in` of a quantifier |

`{passes: c}` and `{fails: c}` are not expression nodes; they occur only in the `when` of a decision row. An omitted `where` is T.

Names in `{ref}` (at most one dot): `now` (timestamp), `actor.id` (id), `actor.keys` (`{set: string}`), a parameter, a quantifier variable, and `self` (only in a derived property expression). `x.prop` reads a declared, typed property of the object binding `x`; a derived property is read only through `{derived}`; `x.id` is not supported (write `{ref: x}`). A quantifier variable must not reuse a reserved name, a parameter name or an outer variable. A derived expression sees only `self`, `now`, `actor` and its own quantifier variables.

### Types and values

`Scalar = enum | timestamp | duration | date | timezone | id | integer | boolean | {ref: T}`; `Type = Scalar | {set: Scalar | string}`. `string` exists only as a set element type.

| Type | Value | Operations |
|---|---|---|
| `timestamp` | epoch milliseconds, a safe integer in [`TIMESTAMP_MIN`, `TIMESTAMP_MAX`] = [-62135510400000, 253402214399999] (0001-01-02T00:00:00.000Z .. 9999-12-30T23:59:59.999Z, inclusive) | compare; `plus(timestamp, duration) -> timestamp` |
| `duration` | seconds, fixed length (safe integer) | compare |
| `integer` | safe integer | compare only, no arithmetic |
| `date` | `"YYYY-MM-DD"` | compare (lexical order); `dateIn(timestamp, timezone) -> date`, year padded to 4 digits |
| `timezone` | a time-zone name accepted by the host's `Intl.DateTimeFormat`; use IANA names, because other forms such as UTC offsets are engine-dependent | only in `dateIn` |
| `enum`, `id`, `{ref: T}` | string | `eq`, `neq`; `id` compares with any `{ref: T}`; two refs need the same `T` |
| `boolean` | `true` / `false` | `eq`, `neq`, `isNull`; in a predicate position true / false / null give T / F / U; no literals |
| `{set: E}` | array (order and repeats do not matter); `E` may be any scalar, `boolean` included | only `in`, `subsetOf` |
| any | `null` = no value | |

Type rules: `lt` `lte` `gt` `gte` need two operands of one type among timestamp, date, duration, integer. `eq` and `neq` reject sets. A literal has no type of its own; it takes the type of its position (the other operand, the function argument, the set element) and must fit it. An operation with two literal operands is an error. `isNull` / `isNotNull` take a non-literal value. A predicate node in a value position is an error; a value node in a predicate position is an error unless its type is `boolean`. There are no boolean literals: write `x` or `not(x)`, not `eq(x, true)`. A derived property used in an expression declares `type`. If its `expr` root is a predicate node, the declared type must be `boolean`; a derived property declared `boolean` must have a predicate root (a value root such as `{ref: self.flag}` is an error); for any other declared type the root is a value node of that type. `evalValue` of a boolean derived property gives true / false / null (U gives null). Dependency cycles are errors.

One format table (`fitsType`) serves literals and parameter values: `id` and `{ref: T}` are non-empty strings; `enum` (and set element `string`) a string; `timezone` a name that `Intl.DateTimeFormat` accepts (no `RangeError`); `date` matches `^\d{4}-\d{2}-\d{2}$`; `timestamp` a safe integer within the bounds above; `duration` and `integer` safe integers; `boolean` `true` or `false`; `{set: E}` an array whose elements fit `E`. A literal that does not fit is a static error (an `ExprError`); a parameter value that does not fit is `INVALID_BINDING` `type`. `values` does not change `fitsType`: a parameter value that fits `enum` but is not among the parameter's `values` is `INVALID_BINDING` `type` from a separate check in the shape step. Properties have no `values`. A project's request validation may reject such a value earlier from `values`; that is the project's projection. The timestamp bounds keep a one-day margin from the years 0 and 10000, which covers every UTC offset, so `dateIn` always gives a year from 1 to 9999. A `plus` result, a `dateIn` timestamp operand or a `now` outside the bounds throws ("timestamp out of supported range"): it means malformed input, not U. `decide` checks `now` in step 0 (input errors), after the action lookup; direct `evalValue` / `evalPredicate` callers get the range check only through `plus` and `dateIn`. A snapshot property value that is not null and does not fit the property's declared type (for example `1` for a `boolean`) is a malformed snapshot and throws when read. `plus` and `dateIn` with a null operand give null.

### Three-valued logic

A comparison, `in` or `subsetOf` with a null operand is U. `and`, `or`, `not` follow Kleene:

| `and` | T | F | U |   | `or` | T | F | U |   | `not` | |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **T** | T | F | U | | **T** | T | T | T | | T | F |
| **F** | F | F | F | | **F** | T | F | U | | F | T |
| **U** | U | F | U | | **U** | T | U | U | | U | U |

Host language comparisons (`null != "A"` is true in JavaScript) are not used. `isNull` / `isNotNull` give T or F. Evaluation does not short-circuit: all operands of every node with more than one operand (`eq` `neq` `lt` `lte` `gt` `gte`, `in`, `subsetOf`, `plus`, `dateIn`, `and`, `or`) and all elements of a quantifier are evaluated before they are combined; an invalid-snapshot error takes precedence over an undefined derived property; the reported derived property is the first in operand order. A derived property without `expr` makes a condition undefined only when evaluation reaches it: a derived property of a null optional ref is null without reading its expression, and an empty quantifier never evaluates its `where`.

### Quantifiers and the closed world

Quantifiers are two-valued. `exists` is T when some element gives T; `all` is T when every element gives T (an element with F or U makes it F); `none = not exists`. An empty collection gives `exists` F, `all` T, `none` T: navigation results are a closed world, not U. Their bodies should be provably two-valued (R12 quantifier_absorbs_unknown; see Static UNKNOWN analysis).

Navigation: a foreign-key link (no `table`, or `table` is an object's `datasource`) follows `via`; a pure link (`table` is no object's `datasource`) reads `snapshot.links[link.id]` rows `{from, to}`. A null `via`, a dangling foreign key (missing or out of scope) and a null optional ref give the empty set; orphan data is a data-integrity question, not U.

Known risk (vacuous truth): from an optional ref that is null, `all` and `none` are always T. This is not an UNKNOWN risk and is not reported. Guard first: `and(isNotNull({ref: x}), all(...))`.

### Static UNKNOWN analysis

Code: `src/unknown.ts`. Two R12 checks, both waivable, find conditions whose U can turn into an unsafe result:

- `unsafe_fallthrough` (key `<ID>:rows.<i>`): all three hold. Row `i` is `passes(c)` and c may be U; no earlier row is `fails(c)`; a later row has a result of class `applied` or `pending`, where the scan stops at the first later `fails(c)` row (included), and `otherwise` counts only when there is no such row. When c is U, that `fails(c)` row matches, so no row after it is reached. Implementation decision: Stage 1 does not analyse the other conditions, so every later row before that stop is taken as reachable. When two rows use `passes(c)`, each is reported. A condition that may be U is not a violation by itself.
- `quantifier_absorbs_unknown`: the body (`where`) of an `exists`, `none` or `all` may be U; the quantifier turns that U into T or F. Every quantifier of a condition is checked, also when no row uses the condition (key `<ID>:<condition id>:<path>`), and every quantifier of a derived property expression (key `derivedProperties.<id>:<path>`). The path uses the type-error notation: `$.none`, `$.and[1].none`, `$.all.where.and[0].exists`. A quantifier inside a derived property is reported once, for the derived property, not again for each condition that reads it.

Soundness contract: for each combination of null / non-null over the nullable reads, the concrete result of `evalPredicate` is in the abstract result. False positives are allowed; false negatives are not. "May be U" means only "not proven two-valued".

Nullability comes from the facts and the parameters; only this analysis treats unknown nullability as null:

- `fieldList` gives each field with `nullable` (a trailing `?` in the source). A field is non-null only when its object's field list says `nullable: false`. Unknown nullability is analysed as may-be-null: a field that is not listed, or an object without a field list (R2 reports both).
- `now` and `actor.id` / `actor.keys` are never null. A quantifier variable or `self` is not null; its property `x.prop` may be null unless the field is non-null.
- An optional parameter may be null, and so may every property read through it. A required parameter is not null (a missing one is `INVALID_BINDING`); its property may be null unless the field is non-null.

Counting: the analysis collects the distinct normalized paths that may be null and that the outer evaluation reads (`self` is replaced by the `of` of the derived property that is inlined). Reads only inside a quantifier are not counted, because a quantifier is T or F outside; a read that also occurs outside a quantifier is counted there. The `from` of a navigation is never counted: a null ref navigates to the empty set, not to U. With k paths, all 2^k combinations are evaluated; for k > 8 (`MAX_NULLABLE_REFS`) the condition is taken as may-be-U without enumeration. A quantifier body is analysed on its own with the same evaluator and the same counting, its variable added to the visible names; a quantifier nested in the body is again T or F there and is analysed on its own.

Abstract evaluation for one combination. A value position gives a subset of {null, value}; a predicate position gives a subset of {T, F, U}:

| Node | Result |
|---|---|
| `ref` | null when its path is null in the combination, else value |
| `lit` (also a set literal) | value |
| `plus`, `dateIn` | null when an operand may be null; value when both operands may be values |
| `eq` `neq` `lt` `lte` `gt` `gte`, `in`, `subsetOf` | U when an operand may be null; T and F when both operands may be values (no narrowing by constants) |
| `isNull` / `isNotNull` | T / F for a null operand, F / T for a value |
| `and`, `or` | Kleene over every pair of the operand results, folded from the left |
| `not` | T and F swap; U stays U |
| `exists`, `none`, `all` | T and F |
| a boolean value in a predicate position | U when null; T and F when a value |
| `{derived: {id, of: {ref: r}}}` | when `r` is null: null (U in a predicate position), without reading the expression; else the expression is inlined with `self` replaced by `r`. A value root gives its value result; a predicate root gives its predicate result, read as null for U and value for T or F in a value position |

Not analysed: an expression that fails the type check (R1), and a condition whose expression reaches a derived property without `expr` anywhere (`condition_unspecified` reports it when a row uses the condition); such a condition is excluded as a whole. A derived property expression is excluded as a whole only when it fails the type check; otherwise each of its quantifier bodies is analysed on its own, and only a body whose evaluation reaches a derived property without `expr` is skipped.

Known false positives, accepted. Fix each with an explicit null guard where the read is, or with a waiver:

- Correlation between reads is ignored: `and(gt(x, 1), eq(y, 2), neq(y, 2))` is always F, but is reported as may-be-U.
- A quantifier body does not see an outer guard: `and(isNotNull({ref: member_id.person_id}), all(...))` does not stop a report on a body that compares `member_id.person_id`. Guard inside the body.

Empty navigation from a null optional ref is a known risk (above), not an UNKNOWN; it is not reported.

### Scope

`scope` is optional. Without it nothing is filtered, `SCOPE_DENIED` never occurs, and `decide` needs `scope = null`. With it, `decide` needs a non-null scope, and each object type has a mode: listed in `scope.global` -> not filtered; `scope.root` -> `id = scope`; any other type -> tenant, `<by> = scope`. The filter is by object type, not by path: every row read (binding lookup, navigation target, pure link row with a tenant end) is filtered first, and lookups by id run on filtered rows (ids may repeat across tenants). Two rows of one type with one id after filtering is a corrupt snapshot (throws).

### Invocation layer and order

`decide(ont, actionId, snapshot, scope, bindings, actor, now)` with `actor = {id, keys, kind}`. Order:

```
shape -> permission -> envelope -> binding and scope -> decision
```

A request-shape check before `decide` (so before its shape step), permission and the envelope rejects a missing key on a `required: true` action (see `idempotencyKey`); it is outside `decide`.

| Step | Result |
|---|---|
| shape (no snapshot read): undeclared parameter (first by sorted name), missing required parameter (absent or null, in declaration order), value not fitting its type, or an `enum` value not among the parameter's `values` | `INVALID_BINDING` with `unknown_param`, `missing`, `type` |
| permission: each alternative is denied (a key missing, or `principals: {kinds, cite}` whose `kinds` lacks `actor.kind`; the cite is not read), passed (all keys and conditional keys), or undecided (only conditional keys missing); the `{none}` form passes, or is denied when its `principals` `kinds` lacks `actor.kind` (never undecided) | `PERMISSION_DENIED`; INDETERMINATE `permission_condition` / `permission_unknown` |
| envelope (idempotency) | `REPLAYED`, `IDEMPOTENCY_CONFLICT`; **not implemented by `decide`**, which has no idempotency key |
| binding and scope: parameters are checked in declaration order, across all parameters (scalar ref and `{set: {ref: T}}`), and the first failing parameter gives the result; each ref parameter is looked up in its own type only; each element of a `{set: {ref: T}}` parameter is bound the same way, in array order, and the first failing element gives the result | `SCOPE_DENIED` (the id exists only outside the scope), `INVALID_BINDING` `not_found` (absent from the type, including ids of other types) |
| decision: first-hit table | a domain result `{result, class, row}` or INDETERMINATE |

The invocation results are a fixed set (`INVOCATION_RESULTS`), not declared by actions. A null optional ref binds; reading its properties gives null. Invalid input (unknown action, scope argument against the declaration, an ill-typed condition, an untyped parameter, a parameter named `now`, `actor` or `self`, a decision row naming an unknown condition, a decision row or `otherwise` whose `result` has no disposition, a type both global and root, a corrupt or incomplete snapshot) throws; it is never a result. A row without a field that evaluation reads (such as the scope field) is incomplete; a field with the value null is not.

### Decision table and INDETERMINATE

`passes(c) := eval(c) = T`; `fails(c) := eval(c) != T`. Rows are tried in order; the first hit gives `{layer: domain, result, class, row, next?}`, with `class` from `dispositions`. Only the rows actually reached matter. INDETERMINATE is neither an invocation result nor a domain result, and is never filled in as rejected or applied. Its reasons:

| Reason | When |
|---|---|
| `unspecified` | a reached row needs a condition without `expr`, or a condition whose evaluation reads a derived property without `expr` (then `derived` names it) |
| `no_row_matched` | no row hit and no `otherwise` |
| `no_decision_table` | the action has no `decision` |
| `permission_condition` | permission depends only on missing conditional keys |
| `permission_unknown` | `permission: unknown` |

### Runtime consistency

Code: `src/reconcile.ts`. For one invocation, three results must be equal:

```
decide(snapshot before the invocation, inputs) = result reported by the runtime = scenario expectation
```

Types:

- `Reported = {result, reason?}`: a result as the runtime or a scenario states it. `reason` is set only for `INVALID_BINDING`. There is no `param`: runtimes do not report it.
- `RuntimeCase = {id, action, snapshot, inputs: {bindings, actor, scope, now}, reported, expected}`: `id` is generated by the harness; `snapshot` is the typed snapshot taken before the invocation, or `null`; `reported` is what the runtime reported, or `null` (not reported); `expected` is the scenario expectation, or `null` (none).
- `ReconcileRow`: `{id, action, status: match, result}`, `{id, action, status: mismatch, evaluator, reported, expected}`, or `{id, action, status: cannot_reconcile, reason, detail?}`.
- `Decode = (raw, type) => Value | undefined` and `TypeDefect = {object, prop, row, value}`.

`reconcile(ont, cases)` gives exactly one row per case, in input order. For each case the first step that applies gives the row:

| Step | Condition | Row |
|---|---|---|
| 1 | `reported.result` is `REPLAYED` or `IDEMPOTENCY_CONFLICT` | `cannot_reconcile`, `envelope`; `decide` is not called |
| 2 | `reported` is `null` | `cannot_reconcile`, `runtime_missing` |
| 3 | `expected` is `null` | `cannot_reconcile`, `expectation_missing` |
| 4 | `snapshot` is `null` | `cannot_reconcile`, `snapshot_missing` |
| 5 | `decide(ont, action, snapshot, scope, bindings, actor, now)` throws | `cannot_reconcile`, `evaluator_error`; `detail` is the error message |
| 6 | `reported.result` is neither an invocation result (`INVOCATION_RESULTS`) nor the `result` of a decision row or of `otherwise` of this action | `cannot_reconcile`, `runtime_unmapped`; `detail` is `reported.result` |
| 7 | the result is INDETERMINATE | `cannot_reconcile`, `indeterminate`; `detail` is its reason |
| 8 | otherwise: `evaluator` is `externalResult` of the result without `param` (a domain result is `{result}`; `INVALID_BINDING` keeps `reason`) | `match` with `result = evaluator` when the three results are pairwise equal; else `mismatch` |

Two `Reported` values are equal when `result` is equal and `reason` is equal (both absent counts as equal).

A missing runtime result is never filled in from the decision table; neither is a missing expectation. The evaluator result is computed only to compare. Envelope results are not reconciled: the evaluator does not implement the envelope, and a replay does not recompute domain conditions, so a replay is not a new decision. An action without a decision table gives no domain result, so every reported result other than an invocation result is unmapped for it.

Once an invocation is inside the domain path of an action with a decision table, the runtime must report the domain result explicitly. A coarse signal, such as the status of a receipt, must not stand in for it: a coarse value can share a name with the expected result and give a false match. `runtime_missing` (nothing reported) and `runtime_unmapped` (a value the action cannot give) record the two ways this evidence fails.

`projectSnapshot(ont, stores, decode)` turns stored rows (keyed by datasource) into a typed `Snapshot` (keyed by object type) and returns `{snapshot, defects}`:

1. A link type with a `table` that is not the `datasource` of any object type (a pure link) is not projected: the function throws `pure link <id> is not projected`.
2. For each object type, in key order: a missing store throws `snapshot lacks store <datasource>`. Otherwise each row is copied with all its columns, and then each property `p` with a declared `type` is projected: a column absent from the row is not projected and is not a defect (`decide` throws when it reads it, as for any incomplete snapshot); a null value stays null and is never passed to `decode`; any other value goes through `decode(raw, type)`, and a result that is `undefined` or does not fit the type (`fitsType`) is a defect `{object, prop: p, row: String(row.id), value: raw}`, and the column keeps its raw value; else the column gets the decoded value. Columns without a declared type are kept as they are.
3. The result is `{snapshot: {objects}, defects}`; `snapshot.links` is not set. When `defects` is not empty the snapshot holds raw values for those columns; do not reconcile with it.

The physical type mapping is checked here: the profile supplies `decode`, which turns a stored value (for example the integers 0 and 1 of SQLite for a boolean) into a value of the declared type, and `fitsType` checks the result.

`Invocation.disposition` stays the optional Stage 0 field of the fact contract. `reconcile` does not read it.

### Existence is not revealed

`SCOPE_DENIED` is internal. `externalResult` maps it and `INVALID_BINDING` `not_found` to one value, `{result: INVALID_BINDING, param, reason: not_found}`, so a caller cannot learn that an id exists in another tenant. Other reasons, such as `type`, are reported as they are.

### Known limit

`dateIn` uses the time zone data of the runtime. Near a time zone rule change the evaluator and another runtime with a different tzdata version may give different dates.
