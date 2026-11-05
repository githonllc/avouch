## Avouch

The business rules of this project are in an Avouch ontology (`*.ontology.yaml`, see `avouch.config.json`). Each rule cites a section of the design documents.

- The commands below use `npx -y @githonllc/avouch`. If the project pins `@githonllc/avouch` as a dependency, run that version instead: `<dir>/node_modules/.bin/avouch`, where `<dir>` has the `package.json` that pins it. If that file is missing, run the project's install step first. Do not run `npx avouch`: `avouch` without the scope is a different npm package.
- Before you implement or change business logic (the permission, conditions, effects or state machine of an action; the writers and readers of a property), read the rule with `npx -y @githonllc/avouch query`. Run `npx -y @githonllc/avouch query --help` for the questions it answers.
- Do not read the ontology file with grep, cat, sed or a script. Comments and neighbouring entries in the text look like rules, but the checker does not read them.
- If the rule is `unspecified` or is in `knownSourceGaps`, the documents do not decide it. Do not invent the behavior: tell your user, and say so in the pull request.
- If the ontology, the documents and the code disagree, do not decide in code. Tell your user which texts disagree.
- To change a rule, change the design document first, or ask your user to. Then update the ontology so that each claim quotes the new text: in Claude Code with `/avouch:scan`, otherwise with the writing rules in https://avouch.dev/llms.txt. Do not add a rule that no document states.
- After you change the ontology or a cited document section, run `npx -y @githonllc/avouch check`, and `npx -y @githonllc/avouch gate docs` if the project has a ledger (`avouch.ledger.jsonl`). Both must exit 0. `check` covers the format rules only; it does not replace the project's tests.
- Do not edit the ledger to make the gate pass without reading the changed section.
