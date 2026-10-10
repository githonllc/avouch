// The toy library project runs through the checker with its own adapter: the format works for more than one project.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import doc from "../examples/library/library.md?raw";
import ontologyText from "../examples/library/library.ontology.yaml?raw";
import { check } from "../src/checker";
import { RULES, type FormatConfig, type Invocation } from "../src/contract";
import { applyPatch } from "../src/patch";
import { buildLibraryFacts, withoutGenerated } from "../examples/library/adapter";
import { libraryEvidence } from "../examples/library/evidence";
import { config } from "../examples/library/profile";

const mutations = import.meta.glob("../examples/library/mutations/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const ont = parse(ontologyText);
const facts = (c: FormatConfig = config) => buildLibraryFacts(doc, libraryEvidence(), c);

describe("toy library project", () => {
  it("the clean toy ontology has no violations and no waivers", () => {
    const r = check(ont, facts());
    for (const x of r.violations) console.log(`FAIL ${x.rule} ${x.kind} ${x.key}: ${x.msg}`);
    expect(r.violations).toEqual([]);
    expect(r.waived).toEqual([]);
  });

  it("has 28 mutations", () => expect(Object.keys(mutations).length).toBe(28));

  for (const [file, text] of Object.entries(mutations))
    it(`mutation ${file.split("/").pop()} fails with exactly its expected rule`, () => {
      const m = parse(text);
      expect(m.expect, "mutation needs `expect: R<n>`").toMatch(/^R\d+$/);
      const r = check(applyPatch(ont, m.patch), facts());
      const rules = [...new Set(r.violations.map((x) => x.rule))].sort();
      if (rules.join() !== m.expect) for (const x of r.violations) console.log(`${file}: ${x.rule} ${x.kind} ${x.key}: ${x.msg}`);
      expect(rules).toEqual([m.expect]);
    });

  it("a registered knownSourceGaps waiver lets mechanism_unspecified pass", () => {
    const patch = parse(Object.entries(mutations).find(([f]) => f.endsWith("lib-r5-mechanism-unspecified.yaml"))![1]).patch;
    const gap = { id: "KDG-X", rule: "R5", kind: "mechanism_unspecified", keys: ["BORROW"], doc_line: "test", conflict: "test", proposed: "test" };
    const r = check(applyPatch(applyPatch(ont, patch), [{ op: "add", path: "/knownSourceGaps/-", value: gap }]), facts());
    expect(r.violations).toEqual([]);
    expect(r.waived.length).toBe(1);
  });

  it("enforced scenario coverage: toy reports criterion_uncovered, waiving every key clears it, an extra key is stale_waiver", () => {
    const enforced = { ...config, scenarioCoverage: "enforced" } as FormatConfig;
    const r = check(ont, facts(enforced));
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((x) => x.rule === "R9")).toBe(true);
    expect(r.violations.some((x) => x.kind === "criterion_uncovered")).toBe(true);
    const gaps = (extra: string[]) =>
      ["criterion_uncovered", "effect_uncovered"].map((kind) => ({
        id: `COV-${kind}`, rule: "R9", kind, doc_line: "test", conflict: "test", proposed: "test",
        keys: [...r.violations.filter((x) => x.kind === kind).map((x) => x.key), ...(kind === "effect_uncovered" ? extra : [])],
      })).filter((g) => g.keys.length);
    const waive = (extra: string[]) => check({ ...ont, knownSourceGaps: gaps(extra) }, facts(enforced));
    expect(waive([]).violations).toEqual([]);
    const stale = waive(["NO_SUCH:key"]).violations;
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ rule: "R9", kind: "stale_waiver" });
  });

  it("the toy profile enables every rule", () => {
    expect(Object.keys(config.rules).sort()).toEqual([...RULES].sort());
    for (const sw of Object.values(config.rules)) expect(sw).toBe(true);
  });

  it("a missing fact is one fact_missing violation", () => {
    const r = check(ont, { ...facts(), eventCatalog: undefined });
    expect(r.violations.map((x) => [x.rule, x.kind, x.key])).toEqual([["R8", "fact_missing", "facts.eventCatalog"]]);
  });

  it("a disabled rule drops its violations and prints a reason", () => {
    const patch = parse(Object.entries(mutations).find(([f]) => f.endsWith("lib-r8-unknown-event.yaml"))![1]).patch;
    const r = check(applyPatch(ont, patch), facts({ ...config, rules: { ...config.rules, R8: { disabled: "x" } } }));
    expect(r.violations).toEqual([]);
    expect(r.info).toContain("rule R8 disabled: x");
  });

  it("a rule without a config entry is reported as rule_not_configured", () => {
    const { R8, ...rest } = config.rules;
    const r = check(ont, facts({ ...config, rules: rest } as FormatConfig));
    expect(r.violations).toContainEqual(expect.objectContaining({ rule: "R8", kind: "rule_not_configured", key: "config.rules.R8" }));
  });

  describe("permission any_of", () => {
    // BORROW's source row is widened to the toy keys create and close (optionally also a third catalog key, x, that no quote names); the ontology names them as alternatives.
    const f = (rowExtra: string[] = []) => {
      const base = facts();
      const rows = new Map(base.permissions!.rows.value);
      rows.set("BORROW", { keys: new Set(["loan:create", "loan:close", ...rowExtra]), text: "`loan:create` `loan:close`" } as any);
      const catalog = { ...base.permissions!.catalog, value: new Set([...base.permissions!.catalog.value, "loan:x"]) };
      return { ...base, permissions: { ...base.permissions!, catalog, rows: { ...base.permissions!.rows, value: rows } } };
    };
    const q = (k: string) => ({ doc: "L10", quote: `\`${k}\`` });
    const alt = (k: string[], extra: object = {}) => ({ keys: k, cite: q(k[0]), ...extra });
    const cond = (k: string) => ({ conditional_keys: [k], conditional_cite: q(k) });
    const withPerm = (permission: unknown) => applyPatch(ont, [{ op: "replace", path: "/actionTypes/BORROW/permission", value: permission }]);
    const run = (permission: unknown, rowExtra?: string[]) => check(withPerm(permission), f(rowExtra));
    const r1 = (r: ReturnType<typeof check>) => r.violations.filter((x) => x.rule === "R1").map((x) => x.msg);
    const create = "loan:create", close = "loan:close";

    it("union equal to the row keys passes", () => {
      expect(run({ any_of: [alt([create]), alt([close])] }).violations).toEqual([]);
      expect(run({ any_of: [alt([create], cond(close)), alt([close])] }).violations).toEqual([]);
    });
    it("a key missing from the union is only permission_mismatch", () => {
      expect(run({ any_of: [alt([create]), alt([close])] }, ["loan:x"]).violations.map((x) => x.kind)).toEqual(["permission_mismatch"]);
    });
    it("the permission_mismatch message lists each key once", () => {
      const m = run({ any_of: [alt([create], cond(close)), alt([close])] }, ["loan:x"]).violations[0].msg;
      expect(m).toBe("permission [loan:create,loan:close] ≠ source row [loan:create,loan:close,loan:x]");
    });
    it("a superset alternative is redundant (R1)", () => {
      const both = { keys: [create, close], cite: q(create) };
      expect(r1(run({ any_of: [alt([create]), both] }))).toEqual(["permission.any_of[1] is redundant: its keys include all keys of any_of[0]"]);
    });
    it("redundancy counts the other alternative's conditional keys", () => {
      const a = alt([create], cond(close));
      expect(r1(run({ any_of: [a, { keys: [create, close], cite: q(create) }] }))).toEqual(["permission.any_of[1] is redundant: its keys include all keys of any_of[0]"]); // (i)
      expect(r1(run({ any_of: [a, alt([create])] }))).toEqual(["permission.any_of[0] is redundant: its keys include all keys of any_of[1]"]); // (ii)
      expect(r1(run({ any_of: [alt([create]), a] }))).toEqual(["permission.any_of[1] is redundant: its keys include all keys of any_of[0]"]); // (iii)
    });
    it("principals count for redundancy: a narrower alternative is not covered by a broader one without principals", () => {
      const P = { principals: { kinds: ["person"], cite: { doc: "L6", quote: "The caller of an action is a Person." } } };
      expect(r1(run({ any_of: [alt([create], P), { keys: [create, close], cite: q(create) }] }))).toEqual([]);
      expect(r1(run({ any_of: [alt([create]), { keys: [create, close], cite: q(create), ...P }] }))).toEqual(["permission.any_of[1] is redundant: its keys include all keys of any_of[0]"]);
    });
    it("principals on both sides: disjoint kinds are not redundant; b's kinds within a's (and b's keys covering a's) are", () => {
      const P = (kinds: string[]) => ({ principals: { kinds, cite: { doc: "L6", quote: "The caller of an action is a Person." } } });
      expect(r1(run({ any_of: [alt([create], P(["person"])), { keys: [create, close], cite: q(create), ...P(["robot"]) }] }))).toEqual([]);
      expect(r1(run({ any_of: [alt([create], P(["person", "robot"])), { keys: [create, close], cite: q(create), ...P(["person"]) }] }))).toEqual([
        "permission.any_of[1] is redundant: its keys include all keys of any_of[0]",
      ]);
    });
    it("equal condition-free alternatives report only the later index", () => {
      expect(r1(run({ any_of: [alt([create]), alt([create])] }))).toEqual(["permission.any_of[1] is redundant: its keys include all keys of any_of[0]"]);
    });
    it("a redundant alternative is reported once, however many alternatives it covers", () => {
      const msgs = r1(run({ any_of: [alt([create]), alt([close]), { keys: [create, close], cite: q(create) }] }));
      expect(msgs).toEqual(["permission.any_of[2] is redundant: its keys include all keys of any_of[0]"]);
      expect(r1(run({ any_of: [alt([create]), alt([create]), alt([create])] }))).toHaveLength(2);
    });
    it("R10 names the original any_of index when an earlier item is not an object", () => {
      const r = run({ any_of: ["junk", { keys: [close], cite: q(create) }, alt([create])] });
      expect(r.violations.filter((x) => x.rule === "R10").map((x) => x.msg)).toContain("any_of[1] cite does not name loan:close");
    });
    it("an alternative cite not quoting the row is permission_cite_mismatch", () => {
      const bad = { keys: [close], cite: { doc: "L10", quote: "not in the row" } };
      expect(run({ any_of: [alt([create]), bad] }).violations.map((x) => [x.rule, x.kind])).toContainEqual(["R10", "permission_cite_mismatch"]);
    });
    it("an alternative cite that does not name its own key is permission_cite_mismatch", () => {
      const r = run({ any_of: [alt([create]), { keys: [close], cite: q(create) }] });
      expect(r.violations.map((x) => [x.rule, x.kind, x.msg])).toEqual([["R10", "permission_cite_mismatch", "any_of[1] cite does not name loan:close"]]);
    });
    it("a single alternative, a none alternative or an extra sibling is an R1 violation", () => {
      for (const p of [{ any_of: [alt([create])] }, { any_of: [alt([create]), { none: "x", cite: q(create) }] }, { any_of: [alt([create]), alt([close])], keys: [create] }])
        expect(run(p).violations.map((x) => x.rule)).toContain("R1");
    });
  });

  describe("invocation evidence", () => {
    const mut = (name: string) => parse(Object.entries(mutations).find(([f]) => f.endsWith(`${name}.yaml`))![1]).patch;
    const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
    // ids of the records the R7 info output reports as malformed
    const malformedInfo = (r: ReturnType<typeof check>) => r.info.map((l) => /: malformed invocation (\S+):/.exec(l)?.[1]).filter((x): x is string => x !== undefined);
    // a fresh evidence map whose borrow invocation is changed by `edit`
    const withBorrow = (edit: (inv: Invocation) => void) => {
      const ev = libraryEvidence();
      edit(ev.get("borrow")![0]);
      return ev;
    };

    describe("deletes", () => {
      const deleting = (value: unknown) => applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/deletes", value }]);
      const onlyDeletes = (objects = ["Loan"]) => applyPatch(deleting(objects), [
        { op: "replace", path: "/actionTypes/BORROW/creates", value: [] },
        { op: "replace", path: "/actionTypes/BORROW/edits", value: [] },
      ]);
      const removed = { row: 2, before: { id: "LN-2", state: "ACTIVE" } };

      it("R1 rejects deletes that is not a list", () => {
        expect(check(deleting("Loan"), facts()).violations).toContainEqual(expect.objectContaining({
          rule: "R1", key: "actionTypes.BORROW", msg: "deletes must be a list",
        }));
      });

      it("R1 rejects an unknown deletes object", () => {
        expect(check(deleting(["Nope"]), facts()).violations).toContainEqual(expect.objectContaining({
          rule: "R1", key: "actionTypes.BORROW", msg: "deletes Nope: unknown object",
        }));
      });

      it("R7 witnesses deletes only when a committed invocation deletes a row", () => {
        const o = deleting(["Loan"]);
        const missing = ["R7", "effect_unwitnessed", "BORROW:deletes:Loan"];
        expect(triples(check(o, facts()))).toEqual([missing]);
        const ev = withBorrow((inv) => inv.delta!.stores.loans.deleted.push(removed));
        expect(triples(check(o, buildLibraryFacts(doc, ev, config)))).toEqual([]);
        const rejected = libraryEvidence();
        rejected.get("borrow")!.push({ ...ev.get("borrow")![0], id: "borrow#rejected", outcome: "rejected" } as unknown as Invocation);
        expect(triples(check(o, buildLibraryFacts(doc, rejected, config)))).toEqual([missing]);
      });

      it("R7 allows the datasource of a delete-only action", () => {
        const ev = withBorrow((inv) => {
          inv.delta = { stores: { loans: { inserted: [], updated: [], deleted: [removed] } }, events: [] };
        });
        expect(triples(check(onlyDeletes(), buildLibraryFacts(doc, ev, config))).filter(([r]) => r === "R7")).toEqual([]);
      });

      it("R11 requires materialization after deleting an input object", () => {
        expect(triples(check(onlyDeletes(), facts())).filter(([r]) => r === "R11")).toEqual([
          ["R11", "materialization_missing", "BORROW:Member.open_loans"],
        ]);
        const o = applyPatch(onlyDeletes(), [{ op: "add", path: "/actionTypes/BORROW/edits/-", value: "Member.open_loans" }]);
        expect(triples(check(o, facts())).filter(([r]) => r === "R11")).toEqual([]);
      });

      it("R11 exempts a materialized target whose object is deleted", () => {
        expect(triples(check(onlyDeletes(["Loan", "Member"]), facts())).filter(([r]) => r === "R11")).toEqual([]);
        const o = applyPatch(onlyDeletes(["Member"]), [
          { op: "replace", path: "/objectTypes/Member/properties/open_loans/materializedFrom/reads", value: ["Member.person_id"] },
        ]);
        expect(triples(check(o, facts())).filter(([r]) => r === "R11")).toEqual([]);
      });

      it("R11 still reports an edit or create of an input when the target's object is deleted", () => {
        const missing = [["R11", "materialization_missing", "BORROW:Member.open_loans"]];
        const edited = applyPatch(onlyDeletes(["Member"]), [{ op: "add", path: "/actionTypes/BORROW/edits/-", value: "Loan.state" }]);
        expect(triples(check(edited, facts())).filter(([r]) => r === "R11")).toEqual(missing);
        const created = applyPatch(onlyDeletes(["Member"]), [{ op: "add", path: "/actionTypes/BORROW/creates/-", value: "Loan" }]);
        expect(triples(check(created, facts())).filter(([r]) => r === "R11")).toEqual(missing);
      });

      it("R6 sweeps incident links of deleted objects", () => {
        const o = applyPatch(onlyDeletes(), [{ op: "remove", path: "/actionTypes/BORROW/link_effects/loan_book" }]);
        expect(triples(check(o, facts()))).toContainEqual(["R6", "link_effect_missing", "BORROW:loan_book"]);
      });

      it("R5 checks cross-context deletes", () => {
        const o = applyPatch(onlyDeletes(["Book"]), [{ op: "remove", path: "/actionTypes/BORROW/crossContext" }]);
        expect(triples(check(o, facts()))).toContainEqual(["R5", "generic", "BORROW"]);
      });

      it("out-of-scope deletes need no store witness and upserts need no deletes", () => {
        const o = applyPatch(deleting(["Shelf"]), [{ op: "add", path: "/outOfScopeObjectTypes", value: { Shelf: "not modelled" } }]);
        expect(triples(check(o, facts())).filter(([r]) => r === "R1" || r === "R7")).toEqual([]);
        const ev = withBorrow((inv) => inv.delta!.stores.loans.deleted.push(removed));
        expect(triples(check(ont, buildLibraryFacts(doc, ev, config)))).toEqual([]);
      });
    });

    it("(i) generated text is in the document, and a cite that quotes it fails R2", () => {
      expect(doc).toContain("BORROW edits Book.state and Member.open_loans");
      const r = check(applyPatch(ont, mut("lib-r2-generated-text")), facts());
      expect([...new Set(r.violations.map((x) => x.rule))]).toEqual(["R2"]);
    });

    it("(ii) an updated column that edits does not declare is column_undeclared", () => {
      const ev = withBorrow((inv) => {
        const u = inv.delta!.stores.books.updated[0];
        u.changes.title = { before: "A", after: "B" };
      });
      expect(triples(check(ont, buildLibraryFacts(doc, ev, config)))).toEqual([["R7", "column_undeclared", "BORROW:Book.title"]]);
    });

    it("(iii) evidenceRequired reports an action without evidence as evidence_missing", () => {
      const o = applyPatch(ont, [{ op: "remove", path: "/actionTypes/RETURN/evidence" }]);
      const r = check(o, facts({ ...config, evidenceRequired: true }));
      const r7 = triples(r).filter(([rule]) => rule === "R7").map((t) => t.join(" ")).sort();
      expect(r7).toEqual(["R7 evidence_missing RETURN", "R7 generic unclaimed:return"]);
    });

    it("(iv) an action whose only invocation was rejected is no-batch", () => {
      const ev = libraryEvidence();
      ev.set("borrow", [{ id: "borrow#0", outcome: "rejected", rolledBackAttempts: 1, snapshot: null, inputs: { bindings: null, actor: null, scope: null, now: null }, delta: null }]);
      expect(triples(check(ont, buildLibraryFacts(doc, ev, config)))).toEqual([["R7", "generic", "BORROW:no-batch"]]);
    });

    it("(v) an effect on a pure link store is witnessed only by a row change in that store", () => {
      const o = applyPatch(ont, [
        { op: "add", path: "/linkTypes/-", value: { id: "loan_tags", from: "Loan", to: "Book", cardinality: "N:M", via: "book_id", doc: "L3", table: "loan_tags" } },
        { op: "add", path: "/actionTypes/BORROW/link_effects/loan_tags", value: { effect: "the new Loan is tagged with the Book", cite: { doc: "L3", quote: "The Loan refers to the Book by book_id" } } },
      ]);
      const unwitnessed = (ev: Map<string, Invocation[]>) =>
        check(o, buildLibraryFacts(doc, ev, config)).violations.filter((x) => x.rule === "R7" && x.kind === "effect_unwitnessed").map((x) => x.key);
      expect(unwitnessed(libraryEvidence())).toContain("BORROW:link:loan_tags");
      const ev = withBorrow((inv) => {
        inv.delta!.stores.loan_tags = { inserted: [{ row: 1, after: { loan_id: "LN-1", book_id: "B-1" } }], updated: [], deleted: [] };
      });
      expect(unwitnessed(ev)).not.toContain("BORROW:link:loan_tags");
      const upd = withBorrow((inv) => {
        inv.delta!.stores.loan_tags = { inserted: [], updated: [{ row: 1, changes: { book_id: { before: "B-1", after: "B-2" } } }], deleted: [] };
      });
      expect(unwitnessed(upd)).toContain("BORROW:link:loan_tags");
    });

    it("(vi) an unresolvable edit is R1 only, never R7", () => {
      for (const edit of ["Book.title.x", "Book.toString"]) {
        const o = applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/edits/-", value: edit }]);
        expect(triples(check(o, facts())), edit).toEqual([["R1", "generic", "actionTypes.BORROW"]]);
      }
    });

    describe("(vii) two objects on one store", () => {
      // BookShelf shares the store books with Book; BORROW edits Book.state and BookShelf.shelf, and its evidence changes both columns
      const shelf = { context: "Catalog", datasource: "books", doc: "L1", properties: { shelf: { class: "canonical", cite: { doc: "L1", quote: "The title of a Book is set when the copy is catalogued." } } } };
      const o = applyPatch(ont, [
        { op: "add", path: "/objectTypes/BookShelf", value: shelf },
        { op: "add", path: "/actionTypes/BORROW/edits/-", value: "BookShelf.shelf" },
      ]);
      const r7 = (extra: Record<string, { before: unknown; after: unknown }>) => {
        const ev = withBorrow((inv) => Object.assign(inv.delta!.stores.books.updated[0].changes, { shelf: { before: "S1", after: "S2" } }, extra));
        return triples(check(o, buildLibraryFacts(doc, ev, config))).filter(([rule]) => rule === "R7");
      };
      it("a column that only the other object declares is column_undeclared for this object", () =>
        expect(r7({}).map((t) => t.join(" ")).sort()).toEqual(["R7 column_undeclared BORROW:Book.shelf", "R7 column_undeclared BORROW:BookShelf.state"]));
      it("a column that no edit of the store declares is column_undeclared once per touched object of the store", () =>
        expect(r7({ title: { before: "A", after: "B" } }).map((t) => t.join(" ")).sort()).toEqual(["R7 column_undeclared BORROW:Book.shelf", "R7 column_undeclared BORROW:Book.title", "R7 column_undeclared BORROW:BookShelf.state", "R7 column_undeclared BORROW:BookShelf.title"]));
    });

    it("(viii) a committed invocation without delta is reported as an info diagnostic and is not counted as committed", () => {
      const ev = libraryEvidence();
      ev.set("borrow", [{ ...ev.get("borrow")![0], delta: null } as unknown as Invocation]);
      expect(triples(check(ont, buildLibraryFacts(doc, ev, config))).map((t) => t.join(" ")).sort()).toEqual(["R7 generic BORROW:no-batch"]);
      expect(malformedInfo(check(ont, buildLibraryFacts(doc, ev, config)))).toEqual(["borrow#0"]);
    });

    it("(ix) a rejected invocation with a delta is reported as an info diagnostic and adds no changes", () => {
      const ev = libraryEvidence();
      const ok = ev.get("borrow")![0];
      ev.set("borrow", [ok, { ...ok, id: "borrow#1", outcome: "rejected", delta: { stores: { members: { inserted: [], updated: [{ row: 1, changes: { blocked: { before: 0, after: 1 } } }], deleted: [] } }, events: [] } } as unknown as Invocation]);
      const r = check(ont, buildLibraryFacts(doc, ev, config));
      expect(triples(r)).toEqual([]);
      expect(malformedInfo(r)).toEqual(["borrow#1"]);
    });

    it("(x) evidenceRequired with R7 disabled reports nothing", () => {
      const o = applyPatch(ont, [{ op: "remove", path: "/actionTypes/RETURN/evidence" }]);
      const r = check(o, facts({ ...config, evidenceRequired: true, rules: { ...config.rules, R7: { disabled: "x" } } }));
      expect(r.violations).toEqual([]);
    });

    it("(xi) evidenceRequired without the evidence fact reports fact_missing and evidence_missing", () => {
      const o = applyPatch(ont, [{ op: "remove", path: "/actionTypes/BORROW/evidence" }, { op: "remove", path: "/actionTypes/RETURN/evidence" }]);
      const r = check(o, { ...facts({ ...config, evidenceRequired: true }), evidence: undefined });
      expect(triples(r).map((t) => t.join(" ")).sort()).toEqual([
        "R6 fact_missing facts.evidence", "R7 evidence_missing BORROW", "R7 evidence_missing RETURN", "R7 fact_missing facts.evidence",
      ]);
    });

    describe("(xii) an ill-shaped invocation record is an info diagnostic, never a crash", () => {
      const r7 = (ev: Map<string, Invocation[]>) => {
        const r = check(ont, buildLibraryFacts(doc, ev, config));
        return { got: triples(r).map((t) => t.join(" ")).sort(), r, mal: malformedInfo(r) };
      };
      // the only borrow record replaced by an ill-shaped committed one: nothing is committed
      const onlyCommitted = (shape: (ok: Record<string, unknown>) => unknown) => {
        const ev = libraryEvidence();
        ev.set("borrow", [shape({ ...ev.get("borrow")![0] }) as Invocation]);
        const { got, mal } = r7(ev);
        expect(mal).toEqual(["borrow#0"]);
        return got;
      };
      const noCommit = ["R7 generic BORROW:no-batch"];
      it("a committed record without a delta key", () => expect(onlyCommitted(({ delta: _, ...rest }) => rest)).toEqual(noCommit));
      it("a committed record whose delta has no stores", () => expect(onlyCommitted((ok) => ({ ...ok, delta: { events: [] } }))).toEqual(noCommit));
      it("a committed record with a null updated row", () =>
        expect(onlyCommitted((ok) => ({ ...ok, delta: { stores: { books: { inserted: [], updated: [null], deleted: [] } }, events: [] } }))).toEqual(noCommit));
      // a well-formed committed record plus one ill-shaped record
      const plus = (extra: unknown) => {
        const ev = libraryEvidence();
        ev.set("borrow", [ev.get("borrow")![0], extra as Invocation]);
        return r7(ev);
      };
      const rejected = { id: "borrow#1", outcome: "rejected", rolledBackAttempts: 1, snapshot: null, inputs: { bindings: null, actor: null, scope: null, now: null }, delta: null };
      it("a rejected record without a delta key", () => {
        const { delta: _, ...noDelta } = rejected;
        const { got, r, mal } = plus(noDelta);
        expect(got).toEqual([]);
        expect(mal).toEqual(["borrow#1"]);
        expect(r.info.find((l) => l.includes("malformed invocation borrow#1"))).toContain("is rejected but has no delta key");
      });
      it("a null entry in the invocation list is keyed by its position", () => { expect(plus(null).got).toEqual([]); expect(plus(null).mal).toEqual(["[1]"]); });
      for (const [label, list] of [["null", null], ["a mapping", {}]] as const)
        it(`an invocation list that is ${label} counts as empty and is keyed <evidence id>:list`, () => {
          const ev = libraryEvidence();
          ev.set("borrow", list as unknown as Invocation[]);
          const { got, mal } = r7(ev);
          expect(got).toEqual(["R7 generic BORROW:no-batch"]);
          expect(mal).toEqual(["list"]);
        });
      it("a record without rolledBackAttempts adds nothing to the attempt count", () => {
        const { rolledBackAttempts: _, ...noAttempts } = rejected;
        const { got, r, mal } = plus(noAttempts);
        expect(got).toEqual([]);
        expect(mal).toEqual(["borrow#1"]);
        expect(r.info.find((l) => l.startsWith("R7 BORROW "))).toContain("1 committed, 0 rejected invocations, 0 rolled-back attempts");
      });
    });

    describe("(xiii) object type membership uses own keys only", () => {
      it("an object type named toString has no state machine to check", () => {
        const o = applyPatch(ont, [{ op: "add", path: "/objectTypes/toString", value: {} }]);
        expect(check(o, facts()).violations.map((x) => x.key)).not.toContain("stateMachines.toString");
      });
      it("creates: [toString] is R1 only, with no crash and no R5 or R7", () => {
        const o = applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/creates/-", value: "toString" }]);
        expect(triples(check(o, facts()))).toEqual([["R1", "generic", "actionTypes.BORROW"]]);
      });
      it("an object type declared as null gives no crash and no R5 or R7", () => {
        const o = applyPatch(ont, [
          { op: "add", path: "/objectTypes/Shelf", value: null },
          { op: "add", path: "/actionTypes/BORROW/creates/-", value: "Shelf" },
          { op: "add", path: "/actionTypes/BORROW/edits/-", value: "Shelf.name" },
        ]);
        expect(triples(check(o, facts())).map((t) => t.join(" ")).sort()).toEqual([
          "R1 generic actionTypes.BORROW", "R1 generic actionTypes.BORROW", "R1 generic objectTypes.Shelf", "R2 table_not_in_catalog objectTypes.Shelf.datasource",
        ]);
      });
      it("an edit of a property without a class does not resolve: R1, no R7 effect_unwitnessed", () => {
        const o = applyPatch(ont, [
          { op: "add", path: "/objectTypes/Book/properties/isbn", value: {} },
          { op: "add", path: "/actionTypes/BORROW/edits/-", value: "Book.isbn" },
        ]);
        expect(triples(check(o, facts())).map((t) => t.join(" ")).sort()).toEqual([
          "R1 generic actionTypes.BORROW", "R1 generic objectTypes.Book.properties.isbn", "R2 property_not_field Book.isbn",
        ]);
      });
    });
  });

  describe("generated blocks are dropped before any fact is extracted", () => {
    const B = (id: string) => `<!-- BEGIN GENERATED: ${id} -->`, E = (id: string) => `<!-- END GENERATED: ${id} -->`;
    const strip = (lines: string[], eol = "\n") => withoutGenerated(lines.join(eol));
    it("drops a block and keeps prose that mentions GENERATED", () => expect(strip(["a", "see GENERATED: here", B("x"), "gen", E("x"), "b"])).toBe("a\nsee GENERATED: here\nb"));
    it("handles CRLF line ends", () => expect(strip(["a", B("x"), "gen", E("x"), "b"], "\r\n")).toBe("a\nb"));
    it("handles indented markers", () => expect(strip(["a", `  ${B("x")}`, "gen", `\t${E("x")} `, "b"])).toBe("a\nb"));
    it("the CRLF toy document yields no fact from its generated block", () => {
      const f = buildLibraryFacts(doc.replace(/\n/g, "\r\n"), libraryEvidence(), config);
      expect(f.containsTerm("Generated from the ontology")).toBe(false);
      expect(f.section("L7")).not.toBe("missing");
    });
    it("throws on a nested block", () => expect(() => strip([B("x"), B("y"), E("y"), E("x")])).toThrow(/opens inside x/));
    it("throws on an end without a begin", () => expect(() => strip(["a", E("x")])).toThrow(/does not close an open block/));
    it("throws on an end that names another block", () => expect(() => strip([B("x"), E("y")])).toThrow(/does not close x/));
    it("throws on an unclosed block", () => expect(() => strip([B("x"), "gen"])).toThrow(/x is not closed/));
    it("keeps a comment that has generated only in lower case", () =>
      expect(strip(["a", "<!-- auto-generated TOC -->", "b"])).toBe("a\n<!-- auto-generated TOC -->\nb"));
    for (const m of ["<!-- BEGIN GENERATED -->", "<!-- GENERATED: x -->", "<!--BEGIN GENERATED: x-->", "<!-- BEGIN GENERATED: x y -->", "<!-- end generated: x -->"])
      it(`throws on the malformed marker ${m}`, () => expect(() => strip(["a", m])).toThrow(/malformed/));
  });

  describe("parameter values", () => {
    const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
    const quote = { doc: "L3", quote: "RETURN records the return_condition of the Loan: GOOD or DAMAGED." };
    const param = (values: string[]) => ({ op: "add" as const, path: "/actionTypes/RETURN/parameters/return_condition", value: { type: "enum", values, optional: true, cite: quote } });
    const cond = (v: string) => ({
      op: "add" as const, path: "/actionTypes/RETURN/conditions/-",
      value: { id: "damaged", expr: { eq: [{ ref: "return_condition" }, { lit: v }] }, cites: [{ cite: quote }] },
    });
    it("a valued enum parameter compared with one of its values passes", () =>
      expect(triples(check(applyPatch(ont, [param(["GOOD", "DAMAGED"]), cond("DAMAGED")]), facts()))).toEqual([]));
    it("a value not in the parameter quote is parameter_value_not_in_quote", () =>
      expect(triples(check(applyPatch(ont, [param(["GOOD", "LOST"])]), facts()))).toEqual([["R2", "parameter_value_not_in_quote", "RETURN:return_condition:LOST"]]));
    it("a literal outside the values is R1 on the condition", () =>
      expect(triples(check(applyPatch(ont, [param(["GOOD", "DAMAGED"]), cond("LOST")]), facts()))).toEqual([["R1", "generic", "actionTypes.RETURN.conditions.damaged"]]));
    it("values on a non-enum parameter is R1", () =>
      expect(triples(check(applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/parameters/member_id/values", value: ["GOOD"] }]), facts()))).toContainEqual(["R1", "generic", "actionTypes.BORROW.parameters.member_id"]));
    const sorted = (r: ReturnType<typeof check>) => triples(r).sort((a, b) => a.join().localeCompare(b.join()));
    it("values on an integer parameter is one R1 on the parameter and none on a condition that compares it", () => {
      const p = { op: "add" as const, path: "/actionTypes/RETURN/parameters/return_condition", value: { type: "integer", values: ["1"], optional: true, cite: quote } };
      const c = { op: "add" as const, path: "/actionTypes/RETURN/conditions/-", value: { id: "damaged", expr: { eq: [{ ref: "return_condition" }, { lit: 1 }] }, cites: [{ cite: quote }] } };
      expect(sorted(check(applyPatch(ont, [p, c]), facts()))).toEqual([
        ["R1", "generic", "actionTypes.RETURN.parameters.return_condition"],
        ["R2", "parameter_value_not_in_quote", "RETURN:return_condition:1"],
        ["R4", "literal_unsupported", "RETURN:damaged:1"],
      ]);
    });
    const shaped = (value: unknown) => ({ op: "add" as const, path: "/actionTypes/RETURN/parameters/return_condition", value: { ...(value as object), optional: true, cite: quote } });
    for (const [label, value] of [
      ["on a {set: enum} parameter", { type: { set: "enum" }, values: ["GOOD", "DAMAGED"] }],
      ["empty", { type: "enum", values: [] }],
      ["repeated", { type: "enum", values: ["GOOD", "GOOD"] }],
      ["with a non-string", { type: "enum", values: ["GOOD", 3] }],
    ] as const)
      it(`values ${label} is R1 on the parameter`, () =>
        expect(sorted(check(applyPatch(ont, [shaped(value)]), facts()))).toEqual([["R1", "generic", "actionTypes.RETURN.parameters.return_condition"]]));
  });

  describe("parameter and actor reads", () => {
    // BORROW declares the parameter member_id; a probe condition reads_probe (unspecified, with hand-written reads) is appended to BORROW.
    const mut = (name: string) => parse(Object.entries(mutations).find(([f]) => f.endsWith(`${name}.yaml`))![1]).patch;
    const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
    const crit = "actionTypes.BORROW.conditions.reads_probe";
    const probe = (reads: unknown) => ({ id: "reads_probe", unspecified: "probe", reads, cites: [{ cite: { doc: "L6", quote: "only that Member may submit BORROW" } }] });
    const reads = (value: unknown) => check(applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/conditions/-", value: probe(value) }]), facts());
    const params = (value: unknown) => check(applyPatch(ont, [{ op: "replace", path: "/actionTypes/BORROW/parameters", value }]), facts());

    it("an undeclared parameter is R1 on the condition", () =>
      expect(triples(check(applyPatch(ont, mut("lib-r1-param-undeclared")), facts()))).toEqual([["R1", "generic", crit]]));
    it("an actor other than id or keys is R1 on the condition", () =>
      expect(triples(check(applyPatch(ont, mut("lib-r1-actor-unknown")), facts()))).toEqual([["R1", "generic", crit]]));
    it("a parameter name not in its quote is parameter_not_in_quote", () =>
      expect(triples(check(applyPatch(ont, mut("lib-r2-parameter-not-in-quote")), facts()))).toEqual([["R2", "parameter_not_in_quote", "BORROW:member_id"]]));
    it("a parameter value not in the condition quote is parameter_value_unsupported", () =>
      expect(triples(check(applyPatch(ont, mut("lib-r4-parameter-value-unsupported")), facts()))).toEqual([["R4", "parameter_value_unsupported", "BORROW:reads_probe:M-1"]]));
    it("actor reads and a parameter read with a quoted value pass; R4 does not classify them", () =>
      expect(reads([{ actor: "id" }, { actor: "keys" }, { param: "member_id", values: ["BORROW"] }]).violations).toEqual([]));
    it("a parameter without a cite is R1", () =>
      expect(triples(params({ ...ont.actionTypes.BORROW.parameters, member_id: { type: { ref: "Member" } } }))).toEqual([["R1", "generic", "actionTypes.BORROW.parameters.member_id"]]));
    it("parameters that are not a mapping are R1", () => {
      const r = params(["member_id"]);
      expect([...new Set(r.violations.map((x) => x.rule))]).toEqual(["R1"]);
      expect(r.violations.map((x) => x.msg)).toContain("parameters must be a mapping name -> {cite}");
    });
    for (const values of [[], [""]])
      it(`a parameter read with values ${JSON.stringify(values)} is R1`, () => {
        const r = reads([{ actor: "id" }, { param: "member_id", values }]);
        expect([...new Set(r.violations.map((x) => x.rule))]).toEqual(["R1"]);
        expect(r.violations.some((x) => x.msg.includes("values must be a non-empty list"))).toBe(true);
      });
    it("a parameter cite quote not verbatim in its section is R2 through the cite walk", () => {
      const r = check(applyPatch(ont, [{ op: "replace", path: "/actionTypes/BORROW/parameters/member_id/cite/quote", value: "member_id is not in L6" }]), facts());
      expect(triples(r)).toContainEqual(["R2", "generic", ".actionTypes.BORROW.parameters.member_id.cite"]);
    });
  });

  describe("idempotencyKey declaration", () => {
    const triples = (r: ReturnType<typeof check>) => r.violations.map((x) => [x.rule, x.kind, x.key]);
    const idem = (v: unknown) => applyPatch(ont, [{ op: "add", path: "/actionTypes/BORROW/idempotencyKey", value: v }]);
    const cite = { doc: "L6", quote: "BORROW takes book_id" };
    it("(a) {required: true, cite} is clean", () => expect(check(idem({ required: true, cite }), facts()).violations).toEqual([]));
    it("(b) a non-boolean required is R1", () =>
      expect(triples(check(idem({ required: "yes", cite }), facts()))).toContainEqual(["R1", "generic", "actionTypes.BORROW.idempotencyKey"]));
    it("(c) {required: false} without a cite is R1", () =>
      expect(triples(check(idem({ required: false }), facts()))).toContainEqual(["R1", "generic", "actionTypes.BORROW.idempotencyKey"]));
    it("(d) a non-verbatim cite quote is R2 under the idempotencyKey cite path", () => {
      const r = check(idem({ required: true, cite: { doc: "L6", quote: "no such words" } }), facts());
      expect(triples(r)).toContainEqual(["R2", "generic", ".actionTypes.BORROW.idempotencyKey.cite"]);
    });
    it("(e) idempotencyDeclarationRequired reports every undeclared action, not the declared one", () => {
      const names = Object.keys(ont.actionTypes);
      const r = check(idem({ required: true, cite }), facts({ ...config, idempotencyDeclarationRequired: true }));
      expect(triples(r).sort()).toEqual(names.filter((n) => n !== "BORROW").map((n) => ["R1", "idempotency_undeclared", n]).sort());
      const all = check(ont, facts({ ...config, idempotencyDeclarationRequired: true }));
      expect(triples(all).sort()).toEqual(names.map((n) => ["R1", "idempotency_undeclared", n]).sort());
    });
    it("(f) without the config an absent field is no violation", () => expect(check(ont, facts()).violations).toEqual([]));
  });
});
