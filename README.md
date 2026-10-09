# Avouch

Avouch is an ontology format whose every claim cites its source. An Avouch file describes objects, links and actions. A checker compares the file with facts that a project adapter extracts from the project's own source documents and evidence.

## Status

Avouch is an experimental draft. It is not a standard. The format can change. A change that breaks existing files raises the version number in both places at the same time (SPEC section 8).

## Why Avouch

1. OWL, SHACL and LinkML describe classes, properties and data constraints. They do not describe commands with preconditions, link effects, state transitions and permissions. Avouch adds this layer.
2. Palantir Foundry has action types, submission criteria and parameters. Avouch uses the same names for its keys (SPEC section 2). Avouch is a file format that is checked against the project's own source documents. It is not a runtime platform.
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
| `src/contract.ts` | `SourceFacts`: the facts with their sources, and diagnostics |
| `src/checker.ts` | `check(ontology, facts)` returns the violations |
| `src/patch.ts` | JSON-pointer patch that the mutation tests use |
| `src/query.ts` | read-only queries over an ontology (`avouch query`) |
| `src/markdown.ts` | built-in adapter for plain Markdown sources (`avouch.json`); see `docs/adapter-guide.md` section 7 |
| `cli/` | command line: `avouch check` (`check.ts`) and `avouch query` (`query.ts`) |
| `tsconfig.build.json` | configuration for the JavaScript and type declaration build |
| `dist/` | build output; not tracked in version control |
| `examples/library/` | toy project: source document, ontology, mutations, adapter, profile, evidence |
| `test/` | tests of the format layer |
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
- `test/markdown.test.ts`: the built-in Markdown adapter: the toy library gives the same findings as with its own adapter (outside the rules the generic adapter cannot check), and each parse convention.
- `test/boundary.test.ts`: the runtime (`src/` and `examples/`) imports only relative paths inside this package. It imports no npm package and no file outside the package.

## Command line

Build with `npm run build`, then run:

```sh
avouch check <ontology.yaml> [--adapter <module|config.json>]
```

In a source checkout, use `node dist/cli/avouch.js` in place of `avouch`.
The command runs both the JSON Schema validator and the checker. Exit code 0 means both pass; 1 means there are schema errors or unwaived violations; 2 means invalid arguments or a file, parsing or adapter error.

The adapter module must export a named function `facts(ontologyPath)` that returns `SourceFacts`, or a promise of `SourceFacts`. It receives the absolute ontology path. The facts include the project profile and source lookup functions; see `src/contract.ts` and `docs/adapter-guide.md`. Adapter paths resolve from the current directory. A `.ts` adapter can load directly only on a Node version that supports type stripping, and its syntax must be supported by that runtime.

An `--adapter` path that ends in `.json` is not loaded as a module: it is the configuration of the built-in Markdown adapter (`src/markdown.ts`, `docs/adapter-guide.md` section 7). Without `--adapter`, `avouch check` reads `avouch.json` in the directory of the ontology file; when that file does not exist, the command prints the reason and the usage and exits with 2. `avouch query` does not read `avouch.json`: its check stays `not_run` unless `--adapter` is given, also with a `.json` configuration.

## Query

`avouch query` answers questions about the specification in an ontology file. It reads the file and changes nothing. It does not read runtime data.

```sh
avouch query <verb> <arg> <ontology.yaml> [--json] [--adapter <module|config.json>]
```

The command takes exactly three positional arguments. The options can be in any position.

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

## Publishing

The npm package is `@githonllc/avouch`, and its command is `avouch`. The package is not published yet. `package.json` has `"private": true`, so `npm publish` refuses the package. Keep that line in every repository copy. Remove it only in the release copy (step 4).

A release needs the explicit approval of the project owner. Do these steps in this sequence:

1. In the source repository, set the new `0.x` version in `package.json` and commit it. During 0.x, publish this one package only.
2. In the source repository, make the release copy. Run the release check into an empty directory that is outside every git worktree:

   ```sh
   npm --prefix tests run avouch:prep -- <absolute empty directory>
   ```

   This command is in the source repository only. The public copy does not contain it. The check does these things:
   - it copies the committed, whitelisted files to `<dir>/tree`;
   - it runs `npm ci`, the type check and the tests there;
   - it writes the `npm pack --dry-run` file list to `<dir>/pack-files.txt`;
   - it writes the boundary scan to `<dir>/scan.txt`.

   It does not push, and it does not publish. The check must exit with code 0, and `scan.txt` must have no `HIT` line.
3. Give the owner the public tree (`<dir>/tree`), `scan.txt` and `pack-files.txt`. Continue only after the owner approves this release.
4. Sign in to npm as a member of the `githonllc` organization, with two-factor authentication (`npm whoami` shows the account). Then publish from the release copy:

   ```sh
   cd <dir>/tree
   npm pkg delete private
   npm publish --dry-run --access public
   npm publish --access public
   ```

   Before the real publish, make sure that the dry-run file list is the same as `pack-files.txt`. A scoped package needs `--access public`, or npm publishes it as restricted. `npm publish` runs `prepack`, which builds `dist/`.
5. Make sure that the release works:
   - `npm view @githonllc/avouch version` shows the new version;
   - in an empty directory, `npm install @githonllc/avouch@<version>` succeeds;
   - `npx avouch check` prints the usage line and exits with code 2.
6. Mirror the same commit to the public repository, and tag it `v<version>`. The mirrored `package.json` keeps `"private": true`.

## Versions and identifiers

The ontology file has `formatVersion: 1`. The schema `$id` is `https://w3id.org/avouch/v1/schema.json`. The version rules are in SPEC section 8.

## License

Copyright 2026 Githon LLC. Licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`. The next section gives the exception.

## Third-party text

SPEC.md section 2 quotes seven short definitions from the Palantir Foundry documentation (https://www.palantir.com/docs/foundry/ontology/overview/). These quotations belong to their authors. The Apache License 2.0 of this project does not apply to them.
