# Avouch

Avouch is an ontology spec whose every claim cites its source. An Avouch file describes objects, links and actions. A checker compares the file with facts that a project adapter extracts from the project's own source documents and evidence.

## Status

Avouch is an experimental draft. It is not a standard. The spec can change. A change that breaks existing files raises the version number in both places at the same time (SPEC section 8).

## Why Avouch

1. OWL, SHACL and LinkML describe classes, properties and data constraints. They do not describe commands with preconditions, link effects, state transitions and permissions. Avouch adds this layer.
2. Palantir Foundry has action types, submission criteria and parameters. Avouch uses the same names for its keys (SPEC section 2). Avouch is a spec for files that are checked against the project's own source documents. It is not a runtime platform.
3. Discipline: each claim has a verbatim quote from its source (R2). An unknown is written explicitly as `unknown` or `unspecified`. A waiver that matches no violation is reported as `stale_waiver`. R7 compares the declarations with execution evidence.

## Quick start

In this directory, run:

```
npm install
npm test
npm run typecheck
```

Read in this order:

1. `SPEC.md`
2. `examples/library/`: `library.md`, then `library.ontology.yaml`, then `adapter.ts`, then `profile.ts`
3. `docs/adapter-guide.md`

## Adopting Avouch

Two steps, in this order.

1. Every project: keep a document review ledger, and run `avouch gate docs` in CI. See "Document review ledger (gate docs)". The gate works with any Markdown style. It guarantees that each changed section of a design document has a recorded review decision. It does not guarantee that the decision is complete: it does not check that a person read the section, that `claims` lists every claim, or that the claimed places say what the section says.
2. For the structured checks, choose one path. The checks are: the field lists and catalogs of R2, and R3, R5, R6, R8, R9 and R10 (SPEC section 5). Each needs a fact from the project's documents (SPEC section 6). R7 needs execution evidence, which the built-in adapter does not read.
   - (a) Write the documents to the Markdown convention, `docs/markdown-convention.md`, and use the built-in adapter. `avouch facts` checks the documents without an ontology.
   - (b) Write your own adapter: `docs/adapter-guide.md` sections 1 to 6. The grammar of the documents is then free.

Avouch does not widen the built-in grammar for one project.

A rule whose fact is not available is switched off in the profile, with a reason: `"rules": {"R8": {"disabled": "<reason>"}}` (in `profile` of the Markdown configuration; `docs/adapter-guide.md` section 5). The checker prints the reason. Without the switch, the rule reports `fact_missing` for the missing fact. The built-in adapter switches R3 and R9 off by itself when their facts are not set, and R7 always (`docs/adapter-guide.md` section 7).

## Layout

| Path | Content |
|---|---|
| `SPEC.md` | concepts (foundation / extension), fields, rules R1–R12, fact contract |
| `ontology.schema.json` | JSON Schema: `$id` and `formatVersion`; shape only, no project values |
| `vocab.ttl` | RDF vocabulary (`ofv:`) for exporting an ontology as RDF; one term per schema field (`test/vocab.test.ts`) |
| `src/contract.ts` | `SourceFacts`: the facts with their sources, and diagnostics |
| `src/checker.ts` | `check(ontology, facts)` returns the violations |
| `src/patch.ts` | JSON-pointer patch that the mutation tests use |
| `src/query.ts` | read-only queries over an ontology (`avouch query`) |
| `src/reconcile.ts` | runtime consistency: `reconcile`, `projectSnapshot` (SPEC section 9) |
| `src/coverage.ts` | decision-row coverage of reconcile rows, with a baseline (`verifyCoverage`, `avouch gate verify`) |
| `src/ledger.ts` | document review ledger: units, outline, ledger shape, pointers (`verifyLedger`, `avouch gate docs`) |
| `src/markdown.ts` | built-in adapter for plain Markdown sources (configured in `avouch.config.json`); see `docs/adapter-guide.md` section 7 |
| `cli/` | command line: `avouch check` (`check.ts`), `avouch query` (`query.ts`), `avouch reconcile` (`reconcile.ts`), `avouch gate verify` and `avouch gate docs` (`gate.ts`) |
| `tsconfig.build.json` | configuration for the JavaScript and type declaration build |
| `dist/` | build output; not tracked in version control |
| `examples/library/` | toy project: source document, ontology, mutations, adapter, profile, evidence |
| `test/` | tests of the spec, checker and CLI |
| `docs/` | guides (`adapter-guide.md`) |
| `LICENSE` | Apache License 2.0 |
| `NOTICE` | copyright notice and third-party text |

## Write an adapter

A project supplies an adapter and a profile. The adapter reads the project's sources and returns `SourceFacts`. The profile sets the rule switches and the project patterns. `docs/adapter-guide.md` explains each fact and walks through the toy library adapter. A project that writes its documents to `docs/markdown-convention.md` needs no adapter; see "Adopting Avouch".

## Tests

- `test/library.test.ts`: the toy library project runs through the checker. The clean ontology has no violations, and each mutation fails with exactly its expected rule.
- `test/schema.test.ts`: the JSON Schema accepts the toy ontology and rejects bad shapes.
- `test/cli.test.ts`: command line results, schema errors, checker violations and adapter errors.
- `test/config.test.ts`: the project configuration `avouch.config.json`: validation, discovery, precedence, and when it is read.
- `test/query.test.ts`: the query functions on the toy ontology and on patched variants of it.
- `test/query-cli.test.ts`: `avouch query`: the JSON envelope, the stamp (git and check), exit codes, text output, and that a query writes no file.
- `test/coverage.test.ts`: `verifyCoverage` on the toy ontology and on patched variants of it: units, gaps, stale baseline entries, failing reconcile rows, and the shape checks.
- `test/reconcile-cli.test.ts`: `avouch reconcile`: JSON lines in and out, exit codes, and the line number in each input error.
- `test/gate-cli.test.ts`: `avouch gate verify`: the pipeline from cases to the gate, text and JSON output, the check with `--adapter`, and exit codes.
- `test/markdown.test.ts`: the built-in Markdown adapter: the toy library gives the same findings as with its own adapter (outside the rules the generic adapter cannot check), and each parse convention.
- `test/boundary.test.ts`: the runtime (`src/` and `examples/`) imports only relative paths inside this package. It imports no npm package and no file outside the package.

## Command line

Build with `npm run build`, then run it. `avouch --help` (or `-h`) prints the usage lines of all commands; `avouch <command> --help` prints the usage of one command. Both exit with 0 and need no files, configuration or git. For example:

```sh
avouch check [-f <ontology.yaml>] [--config <avouch.config.json>] [--adapter <module|config.json>]
```

All four commands (`check`, `query`, `reconcile`, `gate verify`) take the ontology file with `-f <file>` and the project configuration with `--config <file>`. See "Configuration" below for the ontology file and the adapter that a command uses when it is not given them.

In a source checkout, use `node dist/cli/avouch.js` in place of `avouch`.
The command runs both the JSON Schema validator and the checker. Exit code 0 means both pass; 1 means there are schema errors or unwaived violations; 2 means invalid arguments or a file, parsing or adapter error.

The adapter module must export a named function `facts(ontologyPath)` that returns `SourceFacts`, or a promise of `SourceFacts`. It receives the absolute ontology path. The facts include the project profile and source lookup functions; see `src/contract.ts` and `docs/adapter-guide.md`. Adapter paths resolve from the current directory. A `.ts` adapter can load directly only on a Node version that supports type stripping, and its syntax must be supported by that runtime.

An `--adapter` path that ends in `.json` is not loaded as a module: it is the configuration of the built-in Markdown adapter (`src/markdown.ts`, `docs/adapter-guide.md` section 7). Without `--adapter`, the adapter is the `adapter` of the project configuration. `avouch check` always runs the check: when there is no adapter, the command prints the reason and the usage and exits with 2. `avouch query` and `avouch gate verify` run it only with `--check` or `--adapter`; otherwise their check stays `not_run`.

### facts

```sh
avouch facts [--config <avouch.config.json>] [--adapter <config.json>] [--json] [--inventory <file.json>]
```

`avouch facts` checks design documents against the built-in Markdown adapter, without an ontology. It reads the documents of a Markdown configuration (`--adapter <config.json>`, else the `adapter` of the project configuration; a module adapter is an error) and prints what the adapter read: one `FACT <name> <anchor>: <summary>` line for each fact (`FACT <name>: not configured` for a fact without an anchor), one `FIELDS <section>#<first line>: <n> field(s)` line for each top-level `text` code block, a `WARN` line for a line in such a block that is not a field line (a warning only), and a `DIAG <rule> <kind> <key>: <msg>` line for each diagnostic of the adapter. The last line is `OK: 0 diagnostic(s)` or `FAIL: <n> diagnostic(s)`. `--json` prints one object `{"facts", "fields", "warnings", "diagnostics"}` instead. `--inventory <file.json>` compares the facts and fields with an inventory file `{"conventionVersion": 1, "facts": {...}, "fields": {...}, "prose": [...]}` (`conventionVersion` is the version of the Markdown convention, `docs/markdown-convention.md`) (the shapes of `--json`; `prose` is ignored) and prints each difference as `DIFF <path>: inventory <x>, document <y>`. Exit code 0 means no diagnostic and no difference; 1 means a diagnostic or a difference; 2 means invalid arguments or a configuration or file error.

## Configuration

The project configuration `avouch.config.json` names the ontology file and the adapter, so that a command needs no `-f` and no `--adapter`. It is strict JSON; an unknown key is an error. Every path in it is relative to the configuration file.

```json
{
  "ontology": "avouch/avouch.ontology.yaml",
  "adapter": { "markdown": { "docs": ["docs/design.md"], "facts": { "storeCatalog": "#stores" }, "profile": {} } }
}
```

```json
{
  "ontology": "avouch/avouch.ontology.yaml",
  "adapter": "test/avouch-adapter.mjs"
}
```

- `ontology`: optional; when present, a non-empty string. A command that needs the ontology file (`check`, `query`, `reconcile`, `gate verify`) and has no `-f` fails with `<configuration file>: ontology: missing`. `avouch facts` needs no ontology, and `avouch check -f <file>` with a configuration that has no `ontology` uses the adapter of the configuration (there is no ontology to compare with `-f`).
- `adapter`: required, in one of two forms.
  - A string: a file path, relative to the configuration file, with the same meaning as `--adapter`. A path that ends in `.json` is the configuration of the built-in Markdown adapter (a stand-alone file; its `docs` are relative to that file); any other path is an adapter module (`facts(ontologyPath)`). The file is read only when the command uses the adapter. An empty string is an error, and so is a path that is not a file (`<configuration file>: adapter: file not found`). In a query or gate stamp, `check.adapter` is the string as written in the configuration file (as `--adapter` stamps its argument as given).
  - An object with one key, `markdown`: the configuration of the built-in Markdown adapter, inline (`docs`, `facts`, `profile`; `docs/adapter-guide.md` section 7). Any other key (also `module`) is an unknown key. In a stamp, `check.adapter` is `<configuration file>#adapter`, where the configuration file is the `--config` argument as given, or `avouch.config.json` when the file was found at the git top level.
- `ledger`: optional, used only by `avouch gate docs`: an object with the optional keys `file` (the ledger file, relative to the configuration file or absolute; default `avouch.ledger.jsonl`) and `docs` (a non-empty list of distinct document paths, relative to the configuration file; default the `docs` of the Markdown adapter; required with an adapter module). See "Document review ledger (gate docs)".
- An error in the file is reported as `<file>: <json path>: <problem>` with exit code 2.

Where the file is:

1. `--config <file>`, relative to the working directory. A file that does not exist is an error (`--config <file>: file not found`); there is no fallback.
2. Else, with `-f`, `avouch.config.json` at the git top level of the directory of the `-f` file. The configuration belongs to the repository of the ontology, so an ontology in another repository (or in a submodule, which has its own top level) does not use the adapter of the current repository. A directory outside any git repository has no configuration.
3. Else `avouch.config.json` at the git top level of the working directory.

There is no search in parent directories and no hidden file.

What a command uses:

| | Source, in order |
|---|---|
| ontology file | `-f`; the `ontology` of the configuration; `avouch/avouch.ontology.yaml` at the git top level |
| adapter | `--adapter`; the `adapter` of the configuration |

The configuration is read only when the command has no `-f`, or when it must run the check and has no `--adapter`. With `-f` and `--adapter` together, the command reads no configuration and runs no `git`. `avouch check` always runs the check; `avouch query` and `avouch gate verify` run it with `--check` or `--adapter`; `avouch reconcile` never runs it. When the command runs the check without `--adapter` and `-f` is not the ontology of the configuration, the command exits with 2 (`-f <file> is not the ontology in <config> (<ontology>): pass --adapter`), because the adapter of the configuration belongs to the other ontology.

Errors, each with exit code 2:

- `--config <file>: file not found`;
- `no -f and no --config, and the working directory is not in a git repository (or git is not available)`;
- `no -f, no avouch.config.json at <top>, and <top>/avouch/avouch.ontology.yaml does not exist`;
- `no adapter: pass --adapter, or set adapter in <top>/avouch.config.json`. An `avouch.json` next to the ontology is no longer read; if one exists, the message says to set `"adapter"` in `avouch.config.json` to the path of that `avouch.json` (relative to the top level), or to pass it with `--adapter`.

## Query

`avouch query` answers questions about the specification in an ontology file. It reads the file and changes nothing. It does not read runtime data.

```sh
avouch query <verb> <arg> [-f <ontology.yaml>] [--json] [--check] [--config <avouch.config.json>] [--adapter <module|config.json>]
```

The command takes exactly two positional arguments. The options can be in any position.

| Verb | Argument | Answer |
|---|---|---|
| `list` | `actions`, `objects`, `links`, `derived`, `dispositions`, `anchors` or `gaps` | the entries of that kind; `anchors` counts the claims per source anchor |
| `action` | action id, for example `BORROW` | permission, idempotency key, parameters, conditions, the decision rows with the conditions each row requires, edits, creates, emits, link effects, state machine transitions |
| `object` | object type, for example `Book` | properties, derived properties, state machine, links, scope, the actions that write it and the conditions that read it; for an out-of-scope object, the reason and the actions that write it |
| `result` | disposition id | every decision row (and `otherwise`) of every action that gives this result |
| `writes` | `<Object>.<property>`, for example `Book.state` | the actions that edit the property; for a derived property, the actions that edit its inputs, with the input path |
| `reads` | `<Object>.<property>` | the conditions, derived properties and materialized properties that read it, directly or through a derived property |
| `cites` | source anchor, for example `L6` | every claim whose cite names this anchor, in file order, with a JSON Pointer path |
| `link` | link id, for example `loan_book` | the ends of the link, the effect of every action that has an entry for it (`incident` is false for an action that touches neither end: an R6 stray), and `missing`, the actions that touch an end but have no entry (R6 `link_effect_missing`) |

Notes:

- `requires` of a decision row: the row is reached only when each earlier row does not hit. A `passes c` row that does not hit gives `{c, must: "fail"}`; a `fails c` row that does not hit gives `{c, must: "pass"}`. The last entry is the condition of the row itself. `fail` means that `c` is not T (it is F or UNKNOWN). The list is not simplified. It covers the decision table only; the invocation results (permission, shape, binding, idempotency) are not in it.
- `specified` is false when the condition has no expression, does not type-check, or reaches a derived property that has no expression. `blockedBy` names the first such condition in an earlier row. Both are static: `decide` stops at a `blockedBy` row for an input where that condition is undefined (always for an `unspecified` condition; for a derived property without an expression only when evaluation reaches it).
- `reads`: `direct` means the condition expression reads the property itself. `via` lists only the first derived property on the path (a condition that reads A, where A reads B and B reads the property, has `via: [A]`); follow the chain with the `derived` entries. `rows` lists only the rows whose `when` names the condition; later rows and `otherwise` also depend on it through `requires`. A navigation over a foreign-key link reads its `via` when `via` is a declared property of the link's `from` object and neither the `via` nor the object name has a dot, so a navigation in the condition expression itself reads that property directly (`direct: true`), and a navigation in a derived property gives `via: [<derived property>]`; a navigation over a pure link reads no property.
- `writes`: creating an object is listed in `creators`, not in `writers`. A materialized property is not expanded, because the checker (R11) already requires its writers to list it in `edits`.
- `object`: `readers` lists the properties of the object that a condition reads, directly or through derived properties (the full read set, as `reads` gives it).
- `cites` matches the anchor exactly: `L6` does not match `L6a`.
- A condition or derived property that does not type-check is listed in `unanalyzed`; it is not dropped silently.

`--json` prints a versioned envelope: `{avouchQuery: 1, stamp, verb, arg, result}`. The result types are in `src/query.ts`. Without `--json`, the command prints three stamp lines, an empty line, and an indented text form of the result.

The stamp tells which specification answered:

- `ontology`: in git, equal to `git.path`; outside git, the real path of the file relative to the working directory, "/" separated. The stamp holds no absolute path unless you wrote one (`--adapter`, `--config`);
- `git`: the commit, whether the file has uncommitted changes (`dirty`), and its path in the repository; `null` outside a git repository;
- `check`: `not_run`, or, with `--check` or `--adapter`, the result of the same check as `avouch check` (`pass` or `fail`, with the counts). `--check` uses the adapter of the project configuration. In the JSON stamp, `adapter` is the module path, or the source of a Markdown configuration (the `--adapter` path as written, or `<config file>#adapter`, with the `--config` argument as given or `avouch.config.json`). A failed check does not change the exit code.

Exit code 0 means there is a result. 1 means there is no result: the id is not declared, or the list is empty (the envelope is still printed). 2 means invalid arguments, or a file, parsing or adapter error.

## Runtime consistency on the command line

`avouch reconcile` compares the result that the runtime reported with the result of the evaluator and with the scenario expectation (SPEC section 9, Runtime consistency). `avouch gate verify` checks that the reconciled cases cover each decision row. Both commands read files and write no file. They do not run project code: the project's test harness writes the cases.

```sh
avouch reconcile [-f <ontology.yaml>] [--config <avouch.config.json>] --cases <cases.jsonl>
avouch gate verify [-f <ontology.yaml>] --rows <rows.jsonl> [--baseline <baseline.json>] [--json] [--check] [--config <avouch.config.json>] [--adapter <module|config.json>]
```

### reconcile

The cases file has one `RuntimeCase` (SPEC section 9) per line, as JSON. Empty lines are skipped. A case can have more keys than `RuntimeCase`; they are ignored. The command prints one `ReconcileRow` per case, as one JSON line, in input order. For example, `avouch reconcile -f library.ontology.yaml --cases cases.jsonl > rows.jsonl` writes the input of `gate verify`.

Exit code 0 means that each case gave a row, also a `mismatch` or a `cannot_reconcile` row: the command does not judge the rows. 2 means invalid arguments, a file or parse error, or a line that is not a `RuntimeCase`; the message gives the file and the line number. The command does not use exit code 1.

### gate verify

The unit of coverage is the decision row. Each row of a decision table and its `otherwise` is one unit. A unit has the name `<action>:rows.<i>` (`i` from 0) or `<action>:otherwise`, as in the R12 keys. A unit is verified when a `match` row has its action, its `row` and the result of that row. A `mismatch` row does not verify its unit. An action without a decision table has no units; it is printed as `no_table` and does not change the result. The command checks every action of the ontology.

Verified means: for one case, `decide` reached this row, and the runtime result and the expected result are the same as the result of `decide`. The runtime does not report which row it ran. A case without an expected result never verifies a unit: `reconcile` gives `expectation_missing` for it, and the gate prints it as `unasserted`. When the runtime result of such a case is a result that the action cannot give, `reconcile` gives `runtime_unmapped` instead, and the case fails the gate. An action with `permission: unknown` never reaches its decision table in `decide`, so all its units stay as `uncovered` entries until the permission is written.

A gap is a condition that a decision row names and that is declared without an expression (`unspecified`). `decide` stops at the first row that names a gap, so the units from that row to `otherwise` are blocked: they are printed as `blocked` and are not reported as uncovered. Each gap needs an exemption with a reason in the baseline. When a gap gets an expression, the units it blocked become ordinary units. The change that adds the expression must also add cases or `uncovered` entries for them.

The baseline is a JSON file. In this example, the condition `loan_active` has no expression:

```json
{
  "avouchCoverage": 1,
  "uncovered": [
    { "action": "BORROW", "row": 3, "when": { "fails": "returns_in_good_condition" }, "result": "REFERRED" },
    { "action": "BORROW", "row": "otherwise", "when": null, "result": "BORROWED" }
  ],
  "exempt": [
    { "action": "RETURN", "condition": "loan_active", "kind": "unspecified", "reason": "the source does not state when a loan is active" }
  ]
}
```

- `uncovered` lists units that have no `match` yet, each with the `when` and `result` of its row. An entry for a unit that is now verified fails the gate. The tool does not stop new entries; review the baseline diff for that.
- `exempt` lists gaps, each with a non-empty `reason`.
- Both keys are required. A key that is not shown above is an error (exit code 2).
- Without `--baseline`, both lists are empty.
- Units are named by position. When rows are added, removed or moved, the positions change; an `uncovered` entry whose `when` or `result` is not the same as in the ontology is stale (`moved`).

The canonical form of the file is `JSON.stringify(baseline, null, 2)` with a final line break, the keys in the order shown above, `uncovered` in unit order (actions in code-unit order, then rows from 0, then `otherwise`) and `exempt` in action order, then condition order. The gate does not check the form. `--json` prints `uncovered` and `unexempted` in the shape and order of the baseline entries; to make a first baseline, copy them and add a reason to each `unexempted` entry.

The gate fails (exit code 1) when:

| Output | Cause |
|---|---|
| `uncovered` | a unit has no `match`, is not blocked, and is not in `uncovered` of the baseline |
| `unexempted` | a gap has no entry in `exempt` |
| `unreasoned` | an `exempt` entry has no reason, or only white space |
| `stale` | an `uncovered` entry names a unit that does not exist, that has another `when` or `result` (`moved`), that is verified or that is blocked, or repeats an entry; an `exempt` entry names a condition that is not a gap, or repeats an entry |
| `failed` | a reconcile row names an action that the ontology does not have (`action_unknown`); a reconcile row is a `mismatch`; a `cannot_reconcile` row has the reason `runtime_missing`, `runtime_unmapped`, `expectation_unmapped`, `snapshot_missing` or `evaluator_error`, or the reason `indeterminate` with a detail other than `unspecified` and `permission_unknown` (`why` is the detail for `no_row_matched`, `no_decision_table` and `permission_condition`, and `indeterminate` for another detail or none); a `match` row names a row that the action does not have, or a result that is not the result of that row (`row_unknown`) |
| `check` | with `--check` or `--adapter`, the same check as `avouch check` fails |

The reasons `envelope` and `expectation_missing` do not fail the gate, and neither does `indeterminate` with the detail `unspecified` or `permission_unknown`. A replay is not a decision; a case without an expectation states nothing to compare. A case gives `indeterminate` only when it has an expected result that the action can give, so an `indeterminate` case is an expectation that `decide` does not check. It fails the gate unless its detail is one of the two details of a gap that an ontology can declare: `unspecified` is a condition without an expression, which is a gap in `exempt` of the baseline, or a condition that reads a derived property without an expression, which R12 reports as `condition_unspecified`; `permission_unknown` is `permission: unknown`, which R10 reports when it runs. `no_row_matched` means that no row applies and the table has no `otherwise`. `no_decision_table` means that `decide` passed the shape, permission and binding steps of an action without a decision table, so the expected result is wrong. `permission_condition` means that no alternative of the permission passes, and in at least one alternative the caller lacks only conditional keys and `conditional_when` is U or absent: write a `conditional_when` that decides the case, or remove the expectation of the case (it is then `unasserted`).

What the gate does not check. The gate does not compare the runtime result with the expectation of an `indeterminate` case, so a wrong expectation at a declared gap (`unspecified` or `permission_unknown`) passes. The gate does not check that the detail of an `indeterminate` row agrees with the ontology: a rows file made before a gap was filled still passes with `unspecified` or `permission_unknown`, so reconcile the cases again with the current ontology. The gate also keeps no record of a declared gap of its own: no case verifies a unit of a `permission: unknown` action, so each unit is `uncovered`, `baselined` or `blocked`, as any unit that no case verifies; an action without a decision table has no units (the gate prints it as `no_table`); and a condition that reads a derived property without an expression does not block its units, so another case can verify a unit that an `unspecified` case expected. R10 records `permission: unknown`, and R12 records a condition that reads a derived property without an expression; `avouch check` and `gate verify --adapter` run them.

Exit code 0 means the gate passes. 1 means it fails. 2 means invalid arguments (also a repeated option), a file or parse error, an ontology without an `actionTypes` mapping, or a rows or baseline file with a wrong shape. Without `--json`, the command prints one `FAIL` line for each failure, `INFO` lines (`check`, `blocked`, `no_table`, `unasserted`), and a summary line that starts with `PASS` or `FAIL`. `--json` prints `{avouchGate: 1, gate: "verify", check, result}`.

The same gate is a function in the package root, for tests that run without a file system or child processes: `verifyCoverage(ontology, rows, baseline)` returns the `result` object (`src/coverage.ts`). The command is a thin wrapper around it. The function does not run the check.

### Document review ledger (gate docs)

```sh
avouch gate docs [--config <avouch.config.json>] [--json]
```

`avouch gate docs` makes sure that each change to a design document has a recorded review decision. It reads no facts, so it works with any document style. Like `gate verify`, it is a rule of the tool, not of the format.

- Units. The gate removes the BOM and changes CRLF to LF. It does not remove the generated blocks: their text is hashed as other text, so a change in generated text re-opens its unit (fail closed). Then it cuts each document at the ATX headings outside fences. A unit runs from its heading line to the next heading of any level. The text before the first heading is the unit with the path `[]`. The key of a unit is the document, the path (the heading titles from the top-level ancestor to the heading, without closing `#`s) and `n`, the occurrence of that path in the document (from 1). The hash is the sha256 of the unit text, line breaks and trailing spaces included. A unit with only blank lines after its heading needs no entry.
- Outline. The sha256 of the JSON text of the list of `[path, n, heading line]` of all units of a document, in document order, empty units included. The heading line is the exact first line of the unit (`null` for the text before the first heading), so a change of level or of closing `#`s changes the outline, also for an empty unit. A reorder changes the outline.
- Ledger. By default `avouch.ledger.jsonl` next to the configuration file, one JSON value per line (a leading BOM is removed). The first line is `{"avouchLedger":1}`. Then, for each document, one outline entry `{"doc", "outline"}`, and one entry `{"doc", "path", "n", "sha256"}` for each unit that is not empty, with exactly one of `claims` (a non-empty list of distinct JSON Pointers into the ontology) and `noClaim` (a non-empty reason). The lines are sorted by `doc`, then the outline entry, then `path` element by element (a prefix first), then `n`. So two changes to different documents change different lines.
- Pointers. RFC 6901, strict: a `~` must be followed by `0` or `1`, and the root pointer `""` is not a claim. One extension: on an array, a segment selects the element whose `id` is the segment, or the string element equal to it (`/linkTypes/loan_book`). A numeric index does not select an element.
- Configuration. The optional key `"ledger": {"file": "<path>", "docs": ["<path>", ...]}` of `avouch.config.json` (section "Configuration"). A `doc` in the ledger is relative to the directory of `avouch.config.json`, with `/`. The docs of a stand-alone Markdown adapter configuration are converted from the directory of that file. Two names of one file (a link, or a case variant on a case-insensitive file system) are one document named twice.

The gate fails (exit code 1) with one line for each failure: `FAIL changed <key>` (the hash of a unit changed), `FAIL unreviewed <key>` (a unit has no entry), `FAIL stale <key>` (an entry has no unit), `FAIL stale <doc> outline` (an outline entry of a document that is not configured), `FAIL outline <doc>` (the outline entry is missing or has another hash) and `FAIL dangling <key> <pointer>` (a pointer does not resolve). A key is printed as `<doc> <path as JSON> <n>`. The units in each list are in ledger order.

Exit code 2, with one line on stderr, means:

- invalid arguments;
- an error in the configuration (`<file>: <json path>: <problem>`), or a module adapter without `ledger.docs`;
- a missing ledger, ontology or document, or one document named twice;
- a ledger line that is not JSON, or that has a wrong shape, a duplicate key, an unsorted position, a pointer that is not strict RFC 6901, or an unknown version (`<ledger>:<line>: <reason>`).

`--json` prints `{avouchGate: 1, gate: "docs", result}`. Each changed or unreviewed unit has its current `sha256`, its `firstLine` and `entry`: the ledger line of the unit as it is now, without the decision. Add `claims` or `noClaim` to it and put it in the ledger.

The gate does not check that a person read a unit, that `claims` lists every claim of the unit, or that the claimed places say what the unit says. Review the ledger diff in the pull request, next to the document diff. Known limit: two changes to adjacent ledger lines (for example two units of one document that follow each other) can still give a merge conflict in git.

## Claude Code plugin

This repository is also a Claude Code plugin marketplace. Install the plugin:

```sh
claude plugin marketplace add githonllc/avouch
claude plugin install avouch@avouch
```

Inside a Claude Code session, the same two steps are `/plugin marketplace add githonllc/avouch` and `/plugin install avouch@avouch`.

The plugin has two skills and one hook. The skills:
- `cli` (`/avouch:cli`): checks an ontology and runs `avouch query`.
- `scan` (`/avouch:scan [project-dir]`): drafts or updates a project's ontology from its design documents, and records the review decision of each document section in the ledger (`avouch gate docs` must pass). It uses the adapter that the project has configured and never writes an adapter. The result is a candidate. `avouch check` must exit 0, and each source gap is listed with a proposed fix to the document. When most objects have no documented field list, it also writes `avouch/doc-patch.md`: field lists, foreign keys and store names derived from the code, for a human to review and merge into the documents. It never drafts states, permissions or rules from code.

The plugin also has a hook (`hooks/hooks.json`, script `hooks/ontology-read-guard.mjs`, Node 22 or later). Before a Bash or Grep call, it blocks a text read of an ontology (`*.ontology.yaml`, `*.ontology.yml`, or a directory named `ontology` that holds an `*.ontology.yaml` file) with tools such as `grep`, `rg`, `sed`, `cat`, `head`, `python` or `yq`, and tells Claude to use `avouch query`. The reason: text output mixes YAML comments and neighbouring entries with the ontology content, and a comment looks like ontology semantics, but the checker never reads comments. `avouch query` gives the structured permission, conditions, decision rows, effects and citations, with the commit and the check status. The hook allows `avouch` itself, `git`, the Read and Edit tools, searches that do not name the ontology, and a write such as `cat > <file>.ontology.yaml`. A script runtime (`node`, `deno`, `bun`, `python`, `ruby`, `perl`) is blocked only for inline code (`-e`, `-c`, stdin), not for a script file. The hook also allows the locate form `grep -n -- <anchor> <file>.ontology.yaml | cut -d: -f1` that finds the lines to edit; the grep must print line numbers (`-n`). The hook is a reminder, not a guarantee: it matches command text, so a recursive search of a parent directory, a shell variable or `bash -c` is not seen, and the Read tool also shows comments. It does nothing in a clone of this repository, where the test fixtures need the raw text. The hook is part of the plugin: to turn it off, disable or uninstall the plugin.

Before 0.1.3 the two skills were named `avouch-cli` and `aquery-scan`.

The skills run the CLI with `npx -y @githonllc/avouch@<version>`, pinned to the version of this repository. Set `AVOUCH_CLI` to a built `dist/cli/avouch.js` to use a local build instead. The `prepare` script builds `dist/` when npm installs the package from git (`npx -y github:githonllc/avouch`). `skills/scan/fixture/` is the test project for the skill.

## Publishing

The npm package is `@githonllc/avouch`, and its command is `avouch`. `package.json` has `"private": true` in the repository, so an accidental `npm publish` from a working copy is refused. The release workflow removes that line only in its own checkout.

A release needs the explicit approval of the project owner. Releases are published by the GitHub Actions workflow `.github/workflows/release.yml` through npm trusted publishing: no npm token is stored, and npm adds provenance. Do these steps in this sequence:

1. Set the new `0.x` version in `package.json`, `.claude-plugin/plugin.json` and the `npx -y @githonllc/avouch@<version>` pins in `skills/*/SKILL.md`, merge it to `main`, and wait for CI to pass. Check the file list that the CI step `npm pack --dry-run` prints.
2. Tag the merge commit `v<version>` (the same version as `package.json`) and push the tag. The workflow checks that the tag matches the version, runs `npm ci`, the type check and the tests, removes `"private"`, and publishes with `--access public`.
3. The job waits in the `npm` environment until the owner approves it in GitHub. The owner's approval is the release approval.
4. Make sure that the release works:
   - `npm view @githonllc/avouch version` shows the new version (a new version can take a few minutes to become available);
   - in an empty directory, `npx -y @githonllc/avouch@<version>` (no arguments) prints the usage lines and exits with code 2.

Version 0.1.0 was published by hand, because npm accepts a trusted publisher only for a package that exists.

CI and the release workflow run `scripts/scan-private.mjs`. It scans the path and text of each tracked file, and the commit messages of a pull request, for private content: local paths, tokens, private keys, and the patterns in the repository secret `PRIVATE_PATTERNS`. A hit shows only the file and line (or commit) and a pattern label, never the text. Pull requests from forks do not get the secret, so they run with the built-in patterns only. Pushes to `main`, pull requests from this repository and releases fail if the secret is missing.

The secret is generated from a list kept in a private repository; maintainers never edit it by hand. After the list changes, a maintainer runs the generator, which prints a pattern count and a sha256 fingerprint, and re-sets the secret with `gh secret set PRIVATE_PATTERNS`. The scan prints `PRIVATE_PATTERNS: <n> patterns, sha256 <12 hex>` for the patterns it loaded (comment lines dropped, pattern lines joined by `\n`); the next CI run on `main` must show the same count and fingerprint as the generator.

## Versions and identifiers

The ontology file has `formatVersion: 1`. The schema `$id` is `https://w3id.org/avouch/v1/schema.json`. The version rules are in SPEC section 8.

The RDF vocabulary is `vocab.ttl`, namespace `https://w3id.org/avouch/v1/vocab#` (prefix `ofv:`), served at `https://avouch.dev/v1/vocab.ttl`. An RDF export of an ontology (for example the Turtle export of Avouch Studio) names each field with the term of the same name. The check does not read the vocabulary. A change that adds a schema field adds its term in the same change: `test/vocab.test.ts` fails on a field without a term, except for the top-level sections, expressions (exported as one JSON literal), the `properties` of an object type (OWL properties) and the `ref` of a value type (the class itself); each exclusion has its reason in the test.

## License

Copyright 2026 Githon LLC. Licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`. The next section gives the exception.

## Third-party text

SPEC.md section 2 quotes seven short definitions from the Palantir Foundry documentation (https://www.palantir.com/docs/foundry/ontology/overview/). These quotations belong to their authors. The Apache License 2.0 of this project does not apply to them.
