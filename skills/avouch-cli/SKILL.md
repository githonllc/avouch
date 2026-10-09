---
name: avouch-cli
description: Use when a project has an Avouch ontology (`*.ontology.yaml`) and you need to check it or ask it a question — before you implement or change business logic (the permission, conditions, decision rows, effects or state machine of an action; the writers and readers of a property), or before you change a cited document section.
---

# Avouch CLI

`avouch` checks an Avouch ontology against its source documents and answers read-only questions about it. To draft or update an ontology, use the skill `aquery-scan`.

## Run it

In every command below, `avouch` stands for `node "$AVOUCH_CLI"` when `AVOUCH_CLI` is set (a built `dist/cli/avouch.js`), and otherwise for `npx -y @githonllc/avouch@0.1.0` (the npm package; this version matches the plugin). Shell state does not persist between commands, so write the full form in each command.

| Sub-command | Use |
|---|---|
| `check <ontology.yaml> [--adapter <module\|config.json>]` | JSON Schema plus checker rules. Without `--adapter` it reads `avouch.json` next to the ontology (the built-in Markdown adapter). A `.json` path is a Markdown adapter configuration; another path is a module that exports `facts(ontologyPath)`. Exit 0 pass, 1 schema errors or violations, 2 usage, file or adapter error. |
| `query <verb> <arg> <ontology.yaml> [--json] [--adapter <module\|config.json>]` | read-only questions about the specification (below). Without `--adapter` the check status is `not_run`, even when `avouch.json` exists. |

## query

| Verb | When to use |
|---|---|
| `list <actions\|objects\|links\|derived\|dispositions\|anchors\|gaps>` | overview: actions with context and permission keys, objects, links, which document sections the ontology depends on, waived gaps |
| `action <ID>` | before you implement or change an action: permission (`any_of`, `principals`), idempotency key, parameters, conditions, decision rows in order with the conditions each row requires, edits, creates, emits, link effects |
| `object <Type>` | a type: property classes, `canonical_values`, state machine, links, writers, readers |
| `result <DISPOSITION>` | what makes any action return this result |
| `writes <Object>.<prop>` | which actions change a property; for a derived property, which actions change its inputs |
| `reads <Object>.<prop>` | impact of changing a property's meaning: conditions, decision rows and derived properties that read it, directly or `via` a derived property |
| `cites <anchor>` | before you change a document section: every claim that cites it. The anchor matches exactly. |

Notes:

- `requires` on a row: `must: fail` means the condition is not T (F or UNKNOWN). `blockedBy` names the first not-specified condition in an earlier row.
- `reads`: `via` lists only the first derived property; follow the chain with `derived[]`.
- `--json` gives the versioned envelope `{avouchQuery: 1, stamp, verb, arg, result}`.

## Stamp

Every answer starts with the stamp: the ontology path, the git `commit` (with `(dirty)` when the file has uncommitted changes), and `check`. When you quote an answer, give the commit and the check status. Pass `--adapter avouch/avouch.json` (or the project's adapter) to get a real check status.

## Exit codes

0: a result. 1: no result (unknown id, or an empty list); `--json` still prints the envelope. 2: usage, file, YAML or adapter error.

## Conflicts

The answer is the ontology. If it disagrees with the project's documents or code, report the disagreement; do not fix the answer in your head. Before you change a cited section, run `cites` on it and review each claim.
