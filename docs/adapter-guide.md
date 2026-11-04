# Writing an Avouch adapter

This guide is for engineers who want to use Avouch for their own project. It tells you which facts the checker needs, how the toy library adapter supplies them, and how to write the profile.

## 1. The three layers

Avouch has three layers: the format layer (this package), the project profile and adapter (your code), and the ontology instance (your `<project>.ontology.yaml`). SPEC section 1 defines them. The format layer never reads a source document. Your adapter reads your sources and returns `SourceFacts`. The checker compares your ontology with those facts.

## 2. The fact contract

The contract is the `SourceFacts` interface in `src/contract.ts`. Your adapter returns one object of this type.

| Field | Required | Used by |
|---|---|---|
| `config` | yes | all rules: the profile (section 5) |
| `diagnostics` | yes | your adapter's findings (parse errors, duplicate rows); reported and waived like violations |
| `info` | yes | lines that the checker prints |
| `section(anchor)` | yes | R2: finds a section by its anchor; returns the section, `"missing"` or `"ambiguous"` |
| `containsTerm(term)` | yes | R2: is the term in the source |
| `fieldList(anchor, objectType)` | yes | R2 (R6 and R12 also read it): the fields of an object in a section, each with `nullable`, or `null` |
| `storeCatalog` | no | R2 |
| `stateMachines` | no | R3: object type to the state machine at its authoritative anchor |
| `transitionTriggers` | no | R3: object type to `"FROM->TO"` to action ids |
| `contextMembers` | no | R5: context to member names |
| `eventCatalog` | no | R8 |
| `scenarios` | no | R9: scenario id to the cited action ids |
| `permissions` | no | R10 |
| `evidence` | no | R1 (id validity), R6 (`none_but_written`), R7 |

`permissions.quoteNamesKey(quote, key)` is the fourth function that you must supply when you supply `permissions`. R10 uses it to ask: does this quote name this key in the key syntax of your source?

Each optional field can be absent. When a rule that needs an absent field is enabled, the checker reports one `fact_missing` violation and skips the checks that depend on the fact. The table in SPEC section 6 lists the checks that are skipped for each fact.

## 3. Walkthrough: the toy library adapter

`examples/library/adapter.ts` builds `SourceFacts` for `examples/library/library.md`.

- It parses the `## L<n> <title>` headings into sections. A heading anchor that occurs two times gives `"ambiguous"`.
- `fieldList` finds the one `text` code block in the section whose first line is the object name, and reads its `- <field>` lines. A trailing `?` marks the field nullable and is not part of its name. A field that is not listed, or an object without a field list, has unknown nullability.
- `containsTerm` searches the document for the term.
- Before it extracts any fact, it removes every generated block (`<!-- BEGIN GENERATED: <name> -->` to `<!-- END GENERATED: <name> -->`, marker lines included); markers that do not pair throw. No fact may come from text generated from the ontology (SPEC section 4). This stripper is simplified: it does not skip fenced code blocks and does not accept annotated markers. A real adapter must handle the marker syntax of its own generator.
- All other facts are literals with an anchor: the store catalog (`L8`), the state machines (`L4`, `L5`), the transition triggers (`L6`), the context members (`L7`), the event catalog (`L9`) and the permissions (`L10`). The scenarios are a literal without an anchor.

The toy adapter writes these facts as literals to keep the example small. A real adapter must parse them from its sources, so that a change in a source document shows as a violation.

`examples/library/evidence.ts` supplies the execution evidence: for each evidence id, a list of invocation records (SPEC section 4). Each record has a harness-generated id, the outcome, a snapshot reference, the evaluation inputs and, when committed, the net change per store row by row (keyed by a stable row identity) and the events written. The checker derives the changed stores and the committed count from the records. Always set the record id: a record without one is keyed by its list position, and that key is not stable for waivers. Do not reuse a row identity within one invocation (SPEC section 4).

### Writing your own adapter

A project that does not write its documents to the Markdown convention (`docs/markdown-convention.md`) writes its own adapter. Follow these rules:

- Derive every fact from the source text. Parse it at run time, so that a change in a source document shows as a violation.
- Put no expected value in the adapter code: no state, edge, trigger, key, event, scenario or catalog name. A value in code is a value that the check cannot compare with the documents. The toy adapter uses literals only to keep the example small (see above).
- Take no fact from text generated from the ontology (SPEC section 4). Remove generated text before you extract any fact.

Not guaranteed: the checker cannot check these rules. It sees the facts that the adapter returns, not how the adapter made them. Review the adapter in the pull request, as you review the ledger.

## 4. Rules that need no project facts

R1, R4 and R11 never report `fact_missing` (SPEC section 6). R4 and R11 read only the ontology. R1 reads the ontology and the profile; when an action names `evidence`, R1 also needs the `evidence` fact to resolve it.

Parameters and parameter and actor reads (`parameters`, `{param}`, `{actor}`) need no new fact. For these reads, R1 and R4 use only the ontology. R2 checks parameter quotes with the same `section` function as all other quotes.

## 5. The profile

`examples/library/profile.ts` is the toy profile. It is a `FormatConfig`:

- `rules`: one switch for each rule R1–R12, `true` or `{ disabled: "<reason>" }`. Write all of them. A missing entry gives `rule_not_configured`.
- `requiredSource`: the anchor that each permission cite must name (R10).
- `scenarioCoverage`: `"printed"` (default) or `"enforced"` (R9). The toy profile uses the default.
- `crossContextMechanisms`: the legal `via` values of `crossContext` (R5).
- `actionIdPattern`: the pattern of an action id (R1).
- `linkFieldPattern`: the pattern of a field that holds a link (R6).
- `stateProperty`: the default name of the state property (R1, R3). An ontology machine names another property of its object with `stateMachines.<Object>.property`.

A harness that builds its own snapshot, and not through `projectSnapshot` (for example the input of the `reconcile` CLI, which is taken as given), must set each projected property (`properties.<p>.from`) the same way: from the top-level key of the JSON object in its column, null when the column is null or the key is absent or null, never decoded, and not set when the column is absent (SPEC section 9, `projectSnapshot` step 2).

## 6. Run the example

In the package directory, run:

```
npm install
npm test
```

## 7. The built-in Markdown adapter

A project whose specification is plain Markdown can run `avouch check` without writing an adapter. `src/markdown.ts` is a generic adapter: `parseMarkdownConfig(text, file)` reads a JSON configuration (`validateMarkdownConfig(value, where)` checks an object that is already parsed), and `markdownFacts(docs, config)` turns document texts into `SourceFacts`. It reads no file; the command line reads the configuration and the documents.

### Configuration

The configuration is either the `adapter.markdown` object of the project configuration `avouch.config.json` (README, "Configuration"), and `docs` is then relative to that file, or a stand-alone `.json` file. A stand-alone file is named by `--adapter <file>.json`, or by the string `"adapter": "<file>.json"` in `avouch.config.json` (a path relative to that file); its `docs` are relative to the stand-alone file. `avouch check` without `--adapter` uses the `adapter` of `avouch.config.json`. Any other `--adapter` value, or any other string in `adapter`, is loaded as a module. The configuration for the toy library (in the directory of `library.md`; as a stand-alone file, or as the value of `adapter.markdown`) is:

```json
{
  "docs": ["library.md"],
  "facts": { "storeCatalog": "L8", "eventCatalog": "L9", "contextMembers": "L7", "permissions": "L10", "scenarios": "L11", "stateMachines": { "Book": "L4", "Loan": "L5" }, "transitionTriggers": "L6" },
  "profile": { "crossContextMechanisms": ["same_transaction"] }
}
```

- `docs` (required): the source documents, a non-empty list of distinct paths. A relative path resolves from the directory of the configuration file. Two entries that resolve to the same file, or a file that cannot be read, stop the command with exit code 2.
- `facts` (optional): the anchor of the section that holds each optional fact: `storeCatalog` (R2), `eventCatalog` (R8), `contextMembers` (R5), `permissions` (R10), `scenarios` (R9), `stateMachines` and `transitionTriggers` (R3). A fact without an anchor is not supplied. `stateMachines` is an object, not a string: each key is an object type and each value is the anchor of the section that holds the state diagram of that object (`"stateMachines": {"Book": "L4"}`). `stateMachines` and `transitionTriggers` are set together or not at all; one without the other is an error.
- `profile` (optional): `actionIdPattern` and `linkFieldPattern` (regular expression strings), `stateProperty`, `crossContextMechanisms`, `scenarioCoverage`, `idempotencyDeclarationRequired`, `evidenceRequired` and `rules`. A `rules` entry is `true` or `{"disabled": "<reason>"}` and replaces the default for that rule.

An unknown key, a wrong type or an invalid regular expression is an error `<file>: <json path>: <problem>` (exit code 2).

Defaults: `actionIdPattern` `^[A-Z][A-Z_]*$`, `linkFieldPattern` `_id$`, `stateProperty` `state`, `crossContextMechanisms` empty. `requiredSource` is `{R10: <permissions anchor>}` when `facts.permissions` is set, else empty; it cannot be set separately. `scenarioCoverage`, `idempotencyDeclarationRequired` and `evidenceRequired` are set only when given. Rules R1, R2, R4, R5, R6, R8, R10, R11 and R12 are on. R9 is on when `facts.scenarios` is set. R3 is on when `facts.stateMachines` and `facts.transitionTriggers` are set. Without its facts, R9 or R3 is off, like R7, because the adapter supplies no facts for the rule; the checker prints the reason:

| Rule | Reason |
|---|---|
| R3 | facts.stateMachines and facts.transitionTriggers are not set: the Markdown adapter reads state machines only from those sections |
| R7 | the Markdown adapter reads no execution evidence |
| R9 | facts.scenarios is not set: the Markdown adapter reads scenarios only from that section |

### Parse conventions

The grammar of the documents is in `docs/markdown-convention.md`: the general rules, and one section for each fact with its template, example and diagnostics.

### Evidence and R6

The Markdown adapter reads no evidence, so `evidence` is absent. R6 stays on, because its static checks (missing, unspecified and stray link effects, link catalog completeness, stray non-link fields) need only the field lists. The cost is one violation `R6 fact_missing facts.evidence`. Waive it in the ontology:

```yaml
knownSourceGaps:
  - id: NO-EVIDENCE
    rule: R6
    kind: fact_missing
    keys: [facts.evidence]
    doc_line: the sources are plain Markdown; there is no execution evidence
    conflict: R6 none_but_written needs evidence
    proposed: add an evidence adapter
```

Or switch R6 off with `"rules": {"R6": {"disabled": "<reason>"}}`; this also turns off the link checks.

An action that names `evidence` fails R1 when no evidence is supplied. To use the Markdown facts with your own evidence, write a small adapter module that combines them:

```ts
export const facts = () => ({ ...markdownFacts(docs, cfg), evidence });
```

### Query

Without `--check` and without `--adapter`, the check stamp of `avouch query` stays `not_run`. `avouch query ... --check` runs the same check as `avouch check` with the adapter of the project configuration, and `--adapter <file>.json` with that file.

### Check documents without an ontology

`avouch facts` runs this adapter over the documents of a configuration and prints the facts, the fields of each `text` block and the diagnostics, without reading an ontology file. See "facts" in `README.md`.

### The toy library with the generic adapter

`test/markdown.test.ts` runs the clean toy ontology and its 28 mutations through both adapters, with every `evidence` id removed. The findings are the same, except:

- the toy adapter also reports R7 and R6 `none_but_written` (the generic adapter has no evidence);
- the generic adapter also reports R6 `fact_missing facts.evidence`.

The R3 and R9 findings are the same, because the configuration sets `facts.stateMachines`, `facts.transitionTriggers` and `facts.scenarios`. So the generic adapter does not catch three mutations: `lib-r6-none-but-written`, `lib-r7-effect-unwitnessed` and `lib-r7-undeclared-store`. It catches the other 25, `lib-r3-transition-binding`, `lib-r6-link-sweep-missing` and `lib-r9-unknown-scenario` included. With the evidence ids kept, the clean toy fails with three violations: R1 for each of the two evidence ids, and R6 `fact_missing`.
