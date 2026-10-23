// SPEC.md section 5 is the rule table: one row per rule R1–R12, each with the five columns of the header.
import { describe, expect, it } from "vitest";
import specText from "../SPEC.md?raw";

const section = (title: string) => {
  const start = specText.indexOf(`\n## ${title}\n`);
  const end = specText.indexOf("\n## ", start + 1);
  return specText.slice(start, end === -1 ? undefined : end);
};
// Cells of a table row; a `|` inside a code span is not a column break.
const cells = (row: string) => row.replace(/`[^`]*`/g, "``").split("|").slice(1, -1);

describe("SPEC.md", () => {
  it("section 5 has one five-column row for each rule R1–R12, in order", () => {
    const rows = section("5. Rules R1-R12").split("\n").filter((l) => /^\| R\d+ \|/.test(l));
    expect(rows.map((r) => cells(r)[0].trim())).toEqual(Array.from({ length: 12 }, (_, i) => `R${i + 1}`));
    for (const r of rows) expect(cells(r), r.slice(0, 40)).toHaveLength(5);
  });
});
