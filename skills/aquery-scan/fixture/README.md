# aquery-scan test fixture

A toy project ("toolshed") used to test the skill: copy `project/` (not this README, which states the expected answers) to a scratch location, `git init` and commit it, then run `/aquery-scan <copy>` (or a subagent that follows SKILL.md) and check the result yourself.

Expected first scan: `avouch check avouch/<name>.ontology.yaml` exits 0 with `PASS: 0 schema error(s), 0 violation(s), N waived` (N ≈ 8: five missing fact sections, three missing field lists), and only `avouch/` is new.

Traps the result must handle:
1. `docs/design.md` says a member with an old safety briefing may not rent; the ordered rules and `src/rentals.ts` omit it. It must be reported as a document-to-code conflict, not decided.
2. "Staff retire a broken tool outside the system" names no source state. No transition to RETIRED may be written.
3. `closed_at`, missing-row handling and the `forbidden` throw exist only in code. They must not be cited.

Update-mode test: commit the first scan, then edit `docs/design.md` (change the Tool state sentence, add a state, add a `text` field list for Rental, say CLOSE_RENTAL sets `closed_at`) and run the skill again. Expected: every changed hunk is in the change table, `Rental.closed_at` is added with its edit, the stale waiver is removed, and the other waivers are kept.
