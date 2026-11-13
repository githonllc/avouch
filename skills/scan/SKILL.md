---
name: scan
description: Use when asked to scan a project's design documents and code and write or update its Avouch spec (an `*.ontology.yaml` checked by the `avouch` CLI), for example "生成 avouch spec", "扫描项目生成本体", "更新 avouch 本体", "draft an Avouch ontology for this repo".
argument-hint: "[project-dir]"
---

# scan

Draft or update the Avouch ontology of the project in the current directory. The result is a **candidate** that a human repairs. It is accepted only by the deterministic checks (`avouch check` and `avouch gate docs`), never by your own reading.

The Avouch repository is two directories above this skill's base directory (`<base>/../..`): it holds `SPEC.md`, `docs/` and `examples/`.

Invoked as `/avouch:scan [project-dir]`. The argument is the project root; without it, use the git root of the current directory. Run every command below from that root.

## Ground rules

These rules hold in every step. Each one closes a failure that an agent without this skill made.

| Rule | Why |
|---|---|
| Facts come only from the adapter that `avouch.config.json` configures: the built-in Markdown adapter (inline `adapter.markdown`, or the `.json` file that a string `adapter` names), or an adapter module that the project has already committed. Scan does not write or change any adapter file, and does not put state machines, triggers, permission rows or catalogs into code. When no suitable adapter exists (the configured module is missing or does not load, or the documents are not in a form the built-in adapter reads and the project has no module), stop and report the next step from "For AI agents" in `docs/adapter-guide.md` of the Avouch repository: for Markdown documents, the `adapter.markdown` configuration; for other documents, an adapter module written in a new session with the prompt in that section. Do not write the adapter in this session. | The same agent must not write both the expected facts and the declarations in one scan. The check would then agree with itself, and a PASS would prove nothing. |
| At the start, record `git status --porcelain` (in a file outside the repository). At the end, run it again. The only new changes may be the ontology file, `avouch.config.json`, the stand-alone Markdown configuration `.json` file that its `adapter` names (only to add a `facts` anchor), the ledger file (`avouch.ledger.jsonl`, or `ledger.file` of the configuration) and, from Step 3a, `avouch/doc-patch.md`. Any other changed file: scan fails and lists the files. | The guard turns rule 1 and the no-document-edit rules into a check that does not depend on your report. |
| Do not run project code (no `import` of `src/`, no test harness, no database). | Scanning is reading. Running code has side effects and is out of scope. |
| Cite only documents that the adapter reads: the `docs` of the Markdown configuration (inline `adapter.markdown`, or the `.json` file that a string `adapter` names). With a module adapter that has no docs list, the R2 result of `avouch check` decides: a cited anchor that does not exist is a violation. Copy each `quote` character for character from the document. | Avouch claims cite design documents. Read the code to understand it and to find conflicts, but do not cite it. |
| When the documents are silent, do not guess. Write `unknown` or `unspecified`, or leave the item out, and record the gap. | A guessed edge or condition looks like a sourced fact. |
| Do not disable a rule and do not remove a fact anchor to get a PASS. Record each gap in `knownSourceGaps`, with a `proposed` document fix. | The gap list is the repair list for the human. |
| If the documents and the code disagree, the ontology follows the documents. Report the conflict with `file:line` on both sides. | You do not decide which side is correct. The owner does. |
| The guidance on the adapter syntax (`facts` anchors in Step 2, the `field_list_missing` handling in Step 3a and Step 4) applies only to the built-in adapter. With a module adapter, report the gap and do not change documents. | A module adapter has its own grammar, which this skill does not know. |
| Do not refresh a hash in the ledger without reading the unit and recording an outcome (`claims` or `noClaim`). | A refreshed hash with no decision is the silent skip that `avouch gate docs` exists to stop. The checker cannot detect it: it is in "Not guaranteed". |

## Step 0: locate the CLI and the target

In every command of this skill, `avouch` stands for `node "$AVOUCH_CLI"` when `AVOUCH_CLI` is set (a built `dist/cli/avouch.js`), and otherwise for `npx -y avouch@0.1.25` (the npm package; this version matches the plugin). Shell state does not persist between commands, so write the full form in each command.

```sh
avouch check --help 2>&1 | grep -q -- '--config' || echo "STOP: this avouch has no project configuration (avouch.config.json); update it"
git ls-files '*.ontology.yaml' 'avouch.config.json' 'avouch.json' '**/avouch.json' 'avouch.ledger.jsonl'
git status --porcelain > "${TMPDIR:-/tmp}/scan-status-before.txt"   # the guard of the ground rules
```

- No ontology exists: the target is `avouch/avouch.ontology.yaml` and the configuration is `avouch.config.json` at the git top level.
- An ontology exists **with** an `avouch.config.json` at the git top level (or an older `avouch/avouch.json`, see the migration in Step 4): use update mode (Step 4).
- An ontology exists **without** either file, or the project's `AGENTS.md` / `CLAUDE.md` gives the ontology to an owner or another session: stop. Do not write to it. Report what you would change.
- The project has code but no design document: stop. Report which documents are missing (objects with field lists, states, actions and their rules). Do not draft from code alone.

## Step 1: inventory

1. List the design documents (`git ls-files '*.md'` minus changelogs and vendored files). Read them fully.
2. Read the code that holds the business logic: types or schema, migrations, request handlers. For a large repository, dispatch `Explore` subagents per area and ask for `file:line` lists, not summaries.
3. List the headings of each document. An anchor is the first word of a heading (`## L1 Book` → `L1`) or the full heading text (`## Open a rental` → `Open a rental`). Two sections with the same anchor make it ambiguous. Cite only anchors that are unique.

## Step 2: write `avouch.config.json` and the ontology

If `avouch.config.json` exists, keep its `adapter`. Otherwise write `avouch.config.json` at the git top level (paths are relative to the file):

```json
{ "ontology": "avouch/avouch.ontology.yaml", "adapter": { "markdown": { "docs": ["docs/design.md"], "facts": {}, "profile": {} } } }
```

Add a `facts` anchor (`storeCatalog`, `eventCatalog`, `contextMembers`, `permissions`, `scenarios`, `stateMachines`, `transitionTriggers`) only when a document section already holds that fact in the adapter syntax (`docs/markdown-convention.md` of the Avouch repository). R3 runs only when `facts.stateMachines` and `facts.transitionTriggers` are both set, and you may set them only when the documents already hold a state diagram and a transition table in the adapter syntax. Do not add sections to the documents yourself.

Write the ontology in the shape of `examples/library/library.ontology.yaml` of the Avouch repository. Read `SPEC.md` sections 2 and 9 of the Avouch repository for the keys and expressions. Model only what a document states:

- objects, properties (with `class`: write `opaque`, with the deciding text as the cite, only when a document explicitly says that the value is not a fact and that no condition reads it, for example an estimate or a score that no rule uses to decide; a score or estimate that a rule does use to decide is not `opaque`; when the documents say nothing, write `unknown`), state machines;
- property and parameter types: a value that can be a fractional number (a quantity such as 2.5, or a coordinate) is `number`, not `integer`; free text (a name, a phone number, a note) is `string`, which a condition reads only with `isNull` or `isNotNull`, not `enum`;
- links (`*_id` fields);
- actions: parameters, permission, conditions, a decision table only when the document gives an order, edits, creates, deletes, emits, link effects. When the document's API takes an alternate key for an object (for example `source` and `external_ref`), declare a ref parameter with `projectedFrom: [source, external_ref]` and cite the text that names those fields. Declare each of those fields as a parameter of the same action too, with its `type` and a cite whose quote names it: the projection reads them from the request. When the document says that a referenced object that does not exist, or is in another tenant, gives a domain result (not an input error), declare `unresolved: domain` on that required ref parameter and add a condition that tests `isNotNull` of it, used by the row that gives that result. When the permission row says that a conditional key is needed only for some request inputs (for example only when the request gives `amount` above 1000), declare `conditional_when` on that form. It reads only parameters that are not projected, `actor` and literals, and each literal must appear in the `conditional_cite` quote. A comparison with an absent optional parameter is UNKNOWN, so the alternative stays undecided: write `and(isNotNull({ref: amount}), gt({ref: amount}, {lit: 1000}))` so that an absent `amount` gives F. Use `deletes` only when the document says the rows are removed ("removes", "deletes"); a status or `deleted_at` marker is an `edits`;
- dispositions.

When the documents name no bounded context, use one context named after the project and record it as a gap.

Write a state transition only when the document names both its `from` and its `to` state. For example, "staff retire a tool" without the state it leaves is not a transition. Leave it out and report it (report item 4). When R3 is off, the check cannot catch a guessed edge.

Free-text fields that the check does not verify (`out_of_scope`, `unspecified`, a context label) copy the document's sentence verbatim. Do not paraphrase them.

Before you write a quote, prove it is verbatim: `grep -F -- '<quote>' <doc>`. When a claim depends on the other items of a list, or on the list being complete, quote enough text to keep that context. R2 does not check this.

## Step 3: check and repair until clean

```sh
avouch check -f <yaml>; echo "exit=$?"
```

For each `FAIL` line, choose one action:

- Your error (wrong quote, wrong anchor, type error, missing link effect): fix the ontology.
- A real source gap that the check prints (for example `field_list_missing` or `fact_missing`): add a `knownSourceGaps` entry. Fill `id`, `rule`, `kind`, `keys` (exactly as printed), `doc_line`, `conflict` and `proposed` (the document text to add).

A `knownSourceGaps` entry must match a printed violation; an entry that matches nothing fails as `stale_waiver`. A gap that the check does not print (an unstated rule, an unstated transition) goes only into the report.

Repeat until the command exits 0. Also run `avouch query list actions -f <yaml>` and resolve each entry under `unanalyzed`.

## Step 3a: structure patch (when most objects have no field list)

Do this step after Step 3 when at least half of the object types have a `knownSourceGaps` entry of kind `field_list_missing` (count the entries: the check does not print a waived violation). The ontology is then a skeleton: most objects have no fields and no links, so a viewer shows unconnected boxes. The missing structure is usually in the code, but the fix belongs in the documents.

Write `avouch/doc-patch.md`, and replace the file if an earlier run wrote one. When this step does not apply, delete an earlier `avouch/doc-patch.md`. Do not edit the documents: a human reviews the patch and merges what is intended design. Do not add the patched fields to the ontology until a document holds them; the `code:` lines belong to the patch, never to the ontology.

- First line: `<!-- Derived from code at <git short sha>; unreviewed. Merge only the fields that are intended design, then run /avouch:scan again. -->`
- One section per `field_list_missing` object: the target document and heading (the object's `doc`), then a `text` block in the adapter syntax (`docs/markdown-convention.md` of the Avouch repository): the object name on the first line, then one `- <field>` line per column, with a trailing `?` for a nullable column. After the block, one line `code: <file:line>` for each place the fields come from.
- When no document lists the store names, add to the patch one `Store Catalog` section with a `text` block of the table names, one per line.
- Structure only: fields, foreign keys and store names. Do not draft states, transitions, permissions, conditions or decision orders from the code, even when the code has them. List them in the report (item 6) with the code `file:line`. A reviewer tends to accept drafted behavior as written, and the check would then confirm the code's own bugs.
- When the documents and the code name a field differently, use the document's name and put the code name on the `code:` line.

## Step 3b: write the ledger (first draft)

Run this step after Step 3 (and Step 3a). It writes the document review ledger. `avouch gate docs` must then pass. The ledger format is in the README of the Avouch repository, section "Document review ledger (gate docs)".

1. If the project has no ledger file, create it with one line: `{"avouchLedger":1}`. The default file is `avouch.ledger.jsonl` next to `avouch.config.json`. Add a `ledger` key to `avouch.config.json` only if the defaults do not fit: `{"ledger": {"file": "<path>", "docs": ["<path>", ...]}}`. `docs` is required with a module adapter; with the Markdown adapter it defaults to the adapter's `docs`.
2. Run `avouch gate docs --json; echo "exit=$?"`. Each unit in `result.unreviewed` has `entry`: the ledger line of the unit as it is now, without the decision.
3. For each non-empty unit, read the unit, then write its line: the `entry` text with one decision added.
   - `"claims": ["/objectTypes/Book", ...]`: a non-empty list of distinct JSON Pointers into the ontology, one for each ontology item that rests on text of this unit.
   - `"noClaim": "<reason>"`: a non-empty reason, when the unit states nothing that the ontology models (for example an introduction).
   A unit with only blank lines after its heading needs no line.
4. For each document, add the outline line `{"doc": "<doc>", "outline": "<sha256>"}`; the hash is in `result.outline`.
5. Keep the lines in the order that the gate requires: by `doc`, then the outline line, then `path` element by element, then `n`. The units in `result.unreviewed` are already in this order. The gate names the first line that is out of order.
6. Run `avouch gate docs` again until it prints `PASS`. A `FAIL dangling` line means a pointer that does not resolve: fix the pointer, or fix the ontology.

## Step 4: update mode

0. If `avouch/avouch.json` exists and `avouch.config.json` does not (a project from an older version), migrate first: write `avouch.config.json` at the git top level with `ontology` set to the ontology path and `"adapter": "avouch/avouch.json"`; leave `avouch/avouch.json` unchanged (its `docs` paths stay relative to `avouch/`). Newer versions read it only through that `adapter` string.
1. Run the check before you change anything, and keep its output.
2. Find what changed. If the project has no ledger yet, create its header first (Step 3b, item 1): every unit is then `unreviewed`. Run `avouch gate docs --json; echo "exit=$?"`. The lists `changed`, `unreviewed`, `stale`, `outline` and `dangling` of `result` are the change list. Do not take the list from `git log -1 -- <yaml>`. Read the text of each changed or unreviewed unit. Read the code of the same areas for conflicts, as in Step 1.
3. Make a change table with one row per `changed` or `unreviewed` unit: the unit's new text, one ontology outcome — `added <ontology path>`, `re-cited <path>`, `changed <path>`, `deleted <path>`, or `no claim: <reason>` — and the new ledger line (`claims` or `noClaim`). The table is the ledger entries. A new field, state, rule, effect or parameter in a unit is a new item: add it, with the properties and `edits` it implies. A new section that holds a fact in the adapter syntax (for example a store catalog) is a new item too (built-in adapter only): add its anchor to `facts` of the Markdown configuration of the adapter (inline `adapter.markdown`, or the `.json` file that a string `adapter` names) (Step 2). The check passing does not mean the table is done; a missing new item fails no rule. Handle the other lists this way: `stale` removes the entry; `outline` refreshes the outline line, after you have handled every unit of that document; `dangling` fixes the pointer or the ontology.
4. Keep every id. Keep each claim whose cite still passes.
5. For a failing quote: if the document still states the claim, re-cite it with the new text. If it does not, change the claim. If the document removed the claim, delete it.
6. Do not delete or rewrite a `knownSourceGaps` entry unless the check reports it as `stale_waiver`.
7. Do Step 3 and Step 3a again.
8. Write the ledger lines of the table (Step 3b). Step 4 ends when `avouch gate docs` prints `PASS`.

## Report

Answer in this shape:

0. Only when Step 3a ran, first: "`<n>` of `<m>` object types have no documented field list, so the ontology is a skeleton. Review `avouch/doc-patch.md`, merge the intended fields into the documents, then run `/avouch:scan` again."
1. The files written, and the last line of `avouch check` and of `avouch gate docs`, verbatim (`PASS: …`). The result of the guard: the changed files are only those that the ground rules allow.
2. The repair list: one row per `knownSourceGaps` entry (`id`, `keys`, `proposed`).
3. Document-to-code conflicts: the claim, the document `file:line`, the code `file:line`.
4. The items you left `unknown` or `unspecified`.
5. In update mode: the change table from Step 4, one row per unit. The rows are the ledger entries; the human reviewer reads them next to the ledger diff.
6. Behavior that the code has and the documents do not state (states, transitions, permissions, conditions, removals): one row per item, with the code `file:line`. These are questions for the document owner, not drafts.
