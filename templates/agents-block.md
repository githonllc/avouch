## Avouch

The business rules of this project are in an Avouch ontology (`*.ontology.yaml`, see `avouch.config.json`). Each rule cites a section of the design documents.

- Before you implement or change business logic (the permission, conditions, effects or state machine of an action; the writers and readers of a property), read the rule with `npx -y @githonllc/avouch query`. Run `npx -y @githonllc/avouch query --help` for the questions it answers.
- Do not read the ontology file with grep, cat, sed or a script. Comments and neighbouring entries in the text look like rules, but the checker does not read them.
- After you change the ontology or a cited document section, run `npx -y @githonllc/avouch check` and `npx -y @githonllc/avouch gate docs`. Both must exit 0.
- Do not edit the ledger (`avouch.ledger.jsonl`) to make the gate pass without reading the changed section.
