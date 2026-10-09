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
- `stateProperty`: the name of the state property (R1, R3).

## 6. Run the example

In the package directory, run:

```
npm install
npm test
```

## 7. The built-in Markdown adapter

A project whose specification is plain Markdown can run `avouch check` without writing an adapter. `src/markdown.ts` is a generic adapter: `parseMarkdownConfig(text, file)` reads a JSON configuration, and `markdownFacts(docs, config)` turns document texts into `SourceFacts`. It reads no file; the command line reads the configuration and the documents.

### Configuration

The configuration is a JSON file. `avouch check <ontology.yaml>` without `--adapter` reads `avouch.json` in the directory of the ontology file. `--adapter <file>.json` names another configuration; any other `--adapter` value is still loaded as a module. The configuration for the toy library (in the directory of `library.md`) is:

```json
{
  "docs": ["library.md"],
  "facts": { "storeCatalog": "L8", "eventCatalog": "L9", "contextMembers": "L7", "permissions": "L10" },
  "profile": { "crossContextMechanisms": ["same_transaction"] }
}
```

- `docs` (required): the source documents, a non-empty list of distinct paths. A relative path resolves from the directory of the configuration file. Two entries that resolve to the same file, or a file that cannot be read, stop the command with exit code 2.
- `facts` (optional): the anchor of the section that holds each optional fact: `storeCatalog` (R2), `eventCatalog` (R8), `contextMembers` (R5), `permissions` (R10). A fact without an anchor is not supplied.
- `profile` (optional): `actionIdPattern` and `linkFieldPattern` (regular expression strings), `stateProperty`, `crossContextMechanisms`, `scenarioCoverage`, `idempotencyDeclarationRequired`, `evidenceRequired` and `rules`. A `rules` entry is `true` or `{"disabled": "<reason>"}` and replaces the default for that rule.

An unknown key, a wrong type or an invalid regular expression is an error `<file>: <json path>: <problem>` (exit code 2).

Defaults: `actionIdPattern` `^[A-Z][A-Z_]*$`, `linkFieldPattern` `_id$`, `stateProperty` `state`, `crossContextMechanisms` empty. `requiredSource` is `{R10: <permissions anchor>}` when `facts.permissions` is set, else empty; it cannot be set separately. `scenarioCoverage`, `idempotencyDeclarationRequired` and `evidenceRequired` are set only when given. Rules R1, R2, R4, R5, R6, R8, R10, R11 and R12 are on. Three rules are off, because the adapter supplies none of their facts; the checker prints the reason:

| Rule | Reason |
|---|---|
| R3 | the Markdown adapter does not parse state machines or transition triggers |
| R7 | the Markdown adapter reads no execution evidence |
| R9 | the Markdown adapter does not parse scenarios |

### Parse conventions

The conventions are fixed in code, not in configuration.

- Text: a leading byte order mark is removed and CRLF line ends become LF.
- Fences: a line that starts, after at most three spaces, with n >= 3 backticks opens a fence. Only a line of n or more backticks (after at most three spaces) followed by nothing but white space closes it, so a three-backtick line inside a four-backtick fence does not. `~~~` fences and an info string that contains backticks are not supported. A text block is a top-level fence whose info string is exactly `text`; its body runs to its matching closing line, so a text block inside another fence is body text. A fence that is still open at the end of a document is an R2 diagnostic `markdown_fence` (key `doc:<path>`).
- Generated blocks: outside fences, a line that, trimmed, starts with `<!-- BEGIN GENERATED` or `<!-- END GENERATED` is a marker. It must be `<!-- BEGIN GENERATED: <name><any note> -->` or `<!-- END GENERATED: <name> -->` (name: letters, digits, `.`, `_`, `-`). Each block is removed with its marker lines before any fact is read. A comment such as `<!-- GENERATED by a site tool -->` is not a marker. A malformed marker, a nested block, an END that does not match the open block, or a block still open at the end is an R2 diagnostic `markdown_generated_blocks` (key `doc:<path>`); the adapter then reads the document as it is. These diagnostics are R2: with R2 disabled they are dropped, and the adapter reads the raw text, generated content included, so do not disable R2 for a document with generated blocks.
- Sections: an ATX heading `#`..`######`, a space and a title, outside fences. A section runs from its heading to the next heading of the same or a higher level. Each heading has two anchors: the short anchor, which is the first word of the title without one trailing `.` (`## 3.2. Pricing` gives `3.2`, `## L1 Book` gives `L1`), and the full-title anchor, which is the whole title without closing `#` characters (`## Open a rental` gives `Open a rental`). An anchor of two or more sections, in one document or across documents, is `"ambiguous"`; give each cited heading a unique anchor (rename a repeated heading first). A heading whose full title equals the first word of another heading also makes that anchor ambiguous: with `## Book` and `## Book details`, the anchor `Book` is ambiguous and the one-word heading has no unique anchor, so rename one of them. A section's text includes its subsections. An anchor of no section is `"missing"`. Setext headings and `{#id}` anchors are not supported.
- `fieldList(anchor, objectType)`: the one `text` code block in the section whose first line is the object type. Each `- <field>` line is a field; `a / b` lists two fields, a comment (two slashes to the end of the line) is dropped, a trailing `?` marks the field nullable, and a field listed twice is nullable when any of its lines is. Not exactly one such block: `null`.
- `containsTerm(term)`: the term as a whole identifier in any document, generated blocks removed.
- Catalogs (`storeCatalog`, `eventCatalog`, the catalog of `permissions`): the one `text` code block in the section; a text block in a subsection counts toward that one. Each line, without its comment (two slashes to the end of the line) and trimmed, is one name; an empty line is skipped.
- `contextMembers`: each line `- <context>: <member>, <member>` outside fences.
- `permissions`: the one pipe table outside fences in the section (lines that start with `|`; the alignment row is dropped; the trailing `|` is optional; a data row made only of dashes, such as `| - | - |`, is read as an alignment row and dropped). The header has two columns. In each data row, the first cell lists the row names, split on `,`; the keys are the code spans in the second cell, and the second cell is the row text. `\|` and a `|` inside a code span do not split cells. A quote names a key when it contains the key in backticks. R10 requires each permission cite to name the configured `facts.permissions` anchor exactly; a full-title anchor of the same section fails with `permission_cite_mismatch`.

A configured anchor that is missing or ambiguous is a diagnostic of kind `markdown_anchor` (key `facts.<name>`) under the rule of the fact; the fact is still supplied, with an empty value. Any other parse problem (not exactly one catalog block, a catalog line with white space, no context line, a repeated context, not exactly one table, a header or a row without two columns, a repeated row name, of which the first row is kept) is a diagnostic of kind `markdown_parse` with the same key. A diagnostic fails the check like a violation.

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

`avouch query` does not read `avouch.json`: without `--adapter` its check stamp stays `not_run`. `avouch query ... --adapter <file>.json` runs the same check as `avouch check`.

### The toy library with the generic adapter

`test/markdown.test.ts` runs the clean toy ontology and its 28 mutations through both adapters, with every `evidence` id removed. The findings are the same, except:

- the toy adapter also reports R3, R7, R9 and R6 `none_but_written` (the generic adapter has no state machines, transition triggers, scenarios or evidence);
- the generic adapter also reports R6 `fact_missing facts.evidence`.

So the generic adapter does not catch five mutations: `lib-r3-transition-binding`, `lib-r6-none-but-written`, `lib-r7-effect-unwitnessed`, `lib-r7-undeclared-store` and `lib-r9-unknown-scenario`. It catches the other 23, `lib-r6-link-sweep-missing` included. With the evidence ids kept, the clean toy fails with three violations: R1 for each of the two evidence ids, and R6 `fact_missing`.
