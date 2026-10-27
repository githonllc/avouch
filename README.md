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
| `src/markdown.ts` | built-in adapter for plain Markdown sources (`avouch.json`); see `docs/adapter-guide.md` section 7 |
| `cli/` | command line: `avouch check` (`check.ts`), `avouch query` (`query.ts`), `avouch reconcile` (`reconcile.ts`) and `avouch gate verify` (`gate.ts`) |
| `tsconfig.build.json` | configuration for the JavaScript and type declaration build |
| `dist/` | build output; not tracked in version control |
| `examples/library/` | toy project: source document, ontology, mutations, adapter, profile, evidence |
| `test/` | tests of the spec, checker and CLI |
| `docs/` | guides (`adapter-guide.md`) |
| `LICENSE` | Apache License 2.0 |
| `NOTICE` | copyright notice and third-party text |

## Write an adapter

A project supplies an adapter and a profile. The adapter reads the project's sources and returns `SourceFacts`. The profile sets the rule switches and the project patterns. `docs/adapter-guide.md` explains each fact and walks through the toy library adapter.

## Tests

- `test/library.test.ts`: the toy library project runs through the checker. The clean ontology has no violations, and each mutation fails with exactly its expected rule.
- `test/schema.test.ts`: the JSON Schema accepts the toy ontology and rejects bad shapes.
- `test/cli.test.ts`: command line results, schema errors, checker violations and adapter errors.
- `test/query.test.ts`: the query functions on the toy ontology and on patched variants of it.
- `test/query-cli.test.ts`: `avouch query`: the JSON envelope, the stamp (git and check), exit codes, text output, and that a query writes no file.
- `test/coverage.test.ts`: `verifyCoverage` on the toy ontology and on patched variants of it: units, gaps, stale baseline entries, failing reconcile rows, and the shape checks.
- `test/reconcile-cli.test.ts`: `avouch reconcile`: JSON lines in and out, exit codes, and the line number in each input error.
- `test/gate-cli.test.ts`: `avouch gate verify`: the pipeline from cases to the gate, text and JSON output, the check with `--adapter`, and exit codes.
- `test/markdown.test.ts`: the built-in Markdown adapter: the toy library gives the same findings as with its own adapter (outside the rules the generic adapter cannot check), and each parse convention.
- `test/boundary.test.ts`: the runtime (`src/` and `examples/`) imports only relative paths inside this package. It imports no npm package and no file outside the package.

## Command line

Build with `npm run build`, then run:

```sh
avouch check [-f <ontology.yaml>] [--adapter <module|config.json>]
```

All four commands (`check`, `query`, `reconcile`, `gate verify`) take the ontology file with `-f <file>`. Without `-f`, a command uses `avouch/avouch.ontology.yaml` at the git top level of the working directory, so it also works from a subdirectory. Two errors, each with exit code 2: `no -f, and the working directory is not in a git repository`, and `no -f, and <path> does not exist`.

In a source checkout, use `node dist/cli/avouch.js` in place of `avouch`.
The command runs both the JSON Schema validator and the checker. Exit code 0 means both pass; 1 means there are schema errors or unwaived violations; 2 means invalid arguments or a file, parsing or adapter error.

The adapter module must export a named function `facts(ontologyPath)` that returns `SourceFacts`, or a promise of `SourceFacts`. It receives the absolute ontology path. The facts include the project profile and source lookup functions; see `src/contract.ts` and `docs/adapter-guide.md`. Adapter paths resolve from the current directory. A `.ts` adapter can load directly only on a Node version that supports type stripping, and its syntax must be supported by that runtime.

An `--adapter` path that ends in `.json` is not loaded as a module: it is the configuration of the built-in Markdown adapter (`src/markdown.ts`, `docs/adapter-guide.md` section 7). Without `--adapter`, `avouch check` reads `avouch.json` in the directory of the ontology file; when that file does not exist, the command prints the reason and the usage and exits with 2. `avouch query` does not read `avouch.json`: its check stays `not_run` unless `--adapter` is given, also with a `.json` configuration.

## Query

`avouch query` answers questions about the specification in an ontology file. It reads the file and changes nothing. It does not read runtime data.

```sh
avouch query <verb> <arg> [-f <ontology.yaml>] [--json] [--adapter <module|config.json>]
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

Notes:

- `requires` of a decision row: the row is reached only when each earlier row does not hit. A `passes c` row that does not hit gives `{c, must: "fail"}`; a `fails c` row that does not hit gives `{c, must: "pass"}`. The last entry is the condition of the row itself. `fail` means that `c` is not T (it is F or UNKNOWN). The list is not simplified. It covers the decision table only; the invocation results (permission, shape, binding, idempotency) are not in it.
- `specified` is false when the condition has no expression, does not type-check, or reaches a derived property that has no expression. `blockedBy` names the first such condition in an earlier row. Both are static: `decide` stops at a `blockedBy` row for an input where that condition is undefined (always for an `unspecified` condition; for a derived property without an expression only when evaluation reaches it).
- `reads`: `direct` means the condition expression reads the property itself. `via` lists only the first derived property on the path (a condition that reads A, where A reads B and B reads the property, has `via: [A]`); follow the chain with the `derived` entries. `rows` lists only the rows whose `when` names the condition; later rows and `otherwise` also depend on it through `requires`.
- `writes`: creating an object is listed in `creators`, not in `writers`. A materialized property is not expanded, because the checker (R11) already requires its writers to list it in `edits`.
- `object`: `readers` lists the properties of the object that a condition reads, directly or through derived properties (the full read set, as `reads` gives it).
- `cites` matches the anchor exactly: `L6` does not match `L6a`.
- A condition or derived property that does not type-check is listed in `unanalyzed`; it is not dropped silently.

`--json` prints a versioned envelope: `{avouchQuery: 1, stamp, verb, arg, result}`. The result types are in `src/query.ts`. Without `--json`, the command prints three stamp lines, an empty line, and an indented text form of the result.

The stamp tells which specification answered:

- `ontology`: the absolute real path of the file;
- `git`: the commit, whether the file has uncommitted changes (`dirty`), and its path in the repository; `null` outside a git repository;
- `check`: `not_run`, or, with `--adapter`, the result of the same check as `avouch check` (`pass` or `fail`, with the counts). A failed check does not change the exit code.

Exit code 0 means there is a result. 1 means there is no result: the id is not declared, or the list is empty (the envelope is still printed). 2 means invalid arguments, or a file, parsing or adapter error.

## Runtime consistency on the command line

`avouch reconcile` compares the result that the runtime reported with the result of the evaluator and with the scenario expectation (SPEC section 9, Runtime consistency). `avouch gate verify` checks that the reconciled cases cover each decision row. Both commands read files and write no file. They do not run project code: the project's test harness writes the cases.

```sh
avouch reconcile [-f <ontology.yaml>] --cases <cases.jsonl>
avouch gate verify [-f <ontology.yaml>] --rows <rows.jsonl> [--baseline <baseline.json>] [--json] [--adapter <module|config.json>]
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
| `failed` | a reconcile row names an action that the ontology does not have (`action_unknown`); a reconcile row is a `mismatch`; a `cannot_reconcile` row has the reason `runtime_missing`, `runtime_unmapped`, `expectation_unmapped`, `snapshot_missing` or `evaluator_error`, or the reason `indeterminate` with the detail `no_row_matched`; a `match` row names a row that the action does not have, or a result that is not the result of that row (`row_unknown`) |
| `check` | with `--adapter`, the same check as `avouch check` fails |

The reasons `envelope`, `expectation_missing` and `indeterminate` with another detail do not fail the gate. A replay is not a decision; a case without an expectation states nothing to compare. An `indeterminate` result does not fail the gate, except `no_row_matched`; the units that it leaves unverified stay `uncovered` or `blocked`, so the gate still sees them. `no_row_matched` means that no row applies and the table has no `otherwise`.

Exit code 0 means the gate passes. 1 means it fails. 2 means invalid arguments (also a repeated option), a file or parse error, an ontology without an `actionTypes` mapping, or a rows or baseline file with a wrong shape. Without `--json`, the command prints one `FAIL` line for each failure, `INFO` lines (`check`, `blocked`, `no_table`, `unasserted`), and a summary line that starts with `PASS` or `FAIL`. `--json` prints `{avouchGate: 1, gate: "verify", check, result}`.

The same gate is a function in the package root, for tests that run without a file system or child processes: `verifyCoverage(ontology, rows, baseline)` returns the `result` object (`src/coverage.ts`). The command is a thin wrapper around it. The function does not run the check.

## Claude Code plugin

This repository is also a Claude Code plugin marketplace. Install the plugin:

```sh
claude plugin marketplace add githonllc/avouch
claude plugin install avouch@avouch
```

Inside a Claude Code session, the same two steps are `/plugin marketplace add githonllc/avouch` and `/plugin install avouch@avouch`.

The plugin has two skills and one hook. The skills:
- `cli` (`/avouch:cli`): checks an ontology and runs `avouch query`.
- `scan` (`/avouch:scan [project-dir]`): drafts or updates a project's ontology from its design documents. The result is a candidate. `avouch check` must exit 0, and each source gap is listed with a proposed fix to the document. When most objects have no documented field list, it also writes `avouch/doc-patch.md`: field lists, foreign keys and store names derived from the code, for a human to review and merge into the documents. It never drafts states, permissions or rules from code.

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
   - in an empty directory, `npx -y @githonllc/avouch@<version> check` prints the usage line and exits with code 2.

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
