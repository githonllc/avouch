---
name: aquery-scan
description: Use when asked to scan a project's design documents and code and write or update its Avouch spec (an `*.ontology.yaml` checked by the `avouch` CLI), for example "生成 avouch spec", "扫描项目生成本体", "更新 avouch 本体", "draft an Avouch ontology for this repo".
argument-hint: "[project-dir]"
---

# aquery-scan

Draft or update the Avouch ontology of the project in the current directory. The result is a **candidate** that a human repairs. It is accepted only by the deterministic check, never by your own reading.

The Avouch repository is two directories above this skill's base directory (`<base>/../..`): it holds `SPEC.md`, `docs/` and `examples/`.

Invoked as `/aquery-scan [project-dir]`. The argument is the project root; without it, use the git root of the current directory. Run every command below from that root.

## Ground rules

These rules hold in every step. Each one closes a failure that an agent without this skill made.

| Rule | Why |
|---|---|
| Facts come only from the package's Markdown adapter (`avouch.json`). Do not write an adapter module, and do not put state machines, triggers, permission rows or catalogs into code. | A hand-written adapter that holds the expected values makes the check agree with itself. A PASS then proves nothing. |
| Do not run project code (no `import` of `src/`, no test harness, no database). | Scanning is reading. Running code has side effects and is out of scope. |
| Cite only the documents listed in `avouch.json` `docs`. Copy each `quote` character for character from the document. | Avouch claims cite design documents. Read the code to understand it and to find conflicts, but do not cite it. |
| When the documents are silent, do not guess. Write `unknown` or `unspecified`, or leave the item out, and record the gap. | A guessed edge or condition looks like a sourced fact. |
| Do not disable a rule and do not remove a fact anchor to get a PASS. Record each gap in `knownSourceGaps`, with a `proposed` document fix. | The gap list is the repair list for the human. |
| If the documents and the code disagree, the ontology follows the documents. Report the conflict with `file:line` on both sides. | You do not decide which side is correct. The owner does. |

## Step 0: locate the CLI and the target

In every command of this skill, `avouch` stands for `node "$AVOUCH_CLI"` when `AVOUCH_CLI` is set (a built `dist/cli/avouch.js`), and otherwise for `npx -y @githonllc/avouch@0.1.2` (the npm package; this version matches the plugin). Shell state does not persist between commands, so write the full form in each command.

```sh
avouch check 2>&1 | grep -q 'config.json' || echo "STOP: this avouch has no Markdown adapter (avouch.json); update it"
git ls-files '*.ontology.yaml' 'avouch.json' '**/avouch.json'
```

- No ontology exists: the target is `avouch/<repo-name>.ontology.yaml` and the configuration is `avouch/avouch.json`.
- An ontology exists **with** an `avouch.json` beside it: use update mode (Step 4).
- An ontology exists **without** an `avouch.json` beside it, or the project's `AGENTS.md` / `CLAUDE.md` gives the ontology to an owner or another session: stop. Do not write to it. Report what you would change.
- The project has code but no design document: stop. Report which documents are missing (objects with field lists, states, actions and their rules). Do not draft from code alone.

## Step 1: inventory

1. List the design documents (`git ls-files '*.md'` minus changelogs and vendored files). Read them fully.
2. Read the code that holds the business logic: types or schema, migrations, request handlers. For a large repository, dispatch `Explore` subagents per area and ask for `file:line` lists, not summaries.
3. List the headings of each document. An anchor is the first word of a heading (`## L1 Book` → `L1`) or the full heading text (`## Open a rental` → `Open a rental`). Two sections with the same anchor make it ambiguous. Cite only anchors that are unique.

## Step 2: write `avouch.json` and the ontology

`avouch.json` (paths are relative to the file):

```json
{ "docs": ["../docs/design.md"], "facts": {}, "profile": {} }
```

Add a `facts` anchor (`storeCatalog`, `eventCatalog`, `contextMembers`, `permissions`) only when a document section already holds that fact in the adapter syntax (`docs/adapter-guide.md` section 7 of the Avouch repository). Do not add sections to the documents yourself.

Write the ontology in the shape of `examples/library/library.ontology.yaml` of the Avouch repository. Read `SPEC.md` sections 2 and 9 of the Avouch repository for the keys and expressions. Model only what a document states:

- objects, properties (with `class`), state machines;
- links (`*_id` fields);
- actions: parameters, permission, conditions, a decision table only when the document gives an order, edits, creates, emits, link effects;
- dispositions.

When the documents name no bounded context, use one context named after the project and record it as a gap.

Write a state transition only when the document names both its `from` and its `to` state. For example, "staff retire a tool" without the state it leaves is not a transition. Leave it out and report it (report item 4). R3 is off in this adapter, so the check cannot catch a guessed edge.

Free-text fields that the check does not verify (`out_of_scope`, `unspecified`, a context label) copy the document's sentence verbatim. Do not paraphrase them.

Before you write a quote, prove it is verbatim: `grep -F -- '<quote>' <doc>`.

## Step 3: check and repair until clean

```sh
avouch check avouch/<name>.ontology.yaml; echo "exit=$?"
```

For each `FAIL` line, choose one action:

- Your error (wrong quote, wrong anchor, type error, missing link effect): fix the ontology.
- A real source gap that the check prints (for example `field_list_missing` or `fact_missing`): add a `knownSourceGaps` entry. Fill `id`, `rule`, `kind`, `keys` (exactly as printed), `doc_line`, `conflict` and `proposed` (the document text to add).

A `knownSourceGaps` entry must match a printed violation; an entry that matches nothing fails as `stale_waiver`. A gap that the check does not print (an unstated rule, an unstated transition) goes only into the report.

Repeat until the command exits 0. Also run `avouch query list actions <yaml>` and resolve each entry under `unanalyzed`.

## Step 4: update mode

1. Run the check before you change anything, and keep its output.
2. Find what changed: `B=$(git log -1 --format=%h -- <yaml>)`, then `git diff $B..HEAD -- <docs>` (the full diff, not `--stat`). Read `git diff --stat $B..HEAD -- <code>` too, for conflicts.
3. Make a change table with one row per changed document hunk: the hunk's new text, and one outcome — `added <ontology path>`, `re-cited <path>`, `changed <path>`, `deleted <path>`, or `no claim: <reason>`. A new field, state, rule, effect or parameter in a hunk is a new item: add it, with the properties and `edits` it implies. The check passing does not mean the table is done; a missing new item fails no rule.
4. Keep every id. Keep each claim whose cite still passes.
5. For a failing quote: if the document still states the claim, re-cite it with the new text. If it does not, change the claim. If the document removed the claim, delete it.
6. Do not delete or rewrite a `knownSourceGaps` entry unless the check reports it as `stale_waiver`.
7. Do Step 3 again.

## Report

Answer in this shape:

1. The files written, and the last line of the check, verbatim (`PASS: …`).
2. The repair list: one row per `knownSourceGaps` entry (`id`, `keys`, `proposed`).
3. Document-to-code conflicts: the claim, the document `file:line`, the code `file:line`.
4. The items you left `unknown` or `unspecified`.
5. In update mode: the change table from Step 4, one row per document hunk.
