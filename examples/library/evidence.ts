// Toy evidence: one committed invocation each of the borrow and return operations, row by row. A fresh Map per call.
import type { EvaluationInputs, Invocation } from "../../src/contract.js";

const inputs = (bindings: unknown): EvaluationInputs => ({ bindings, actor: { id: "M-1" }, scope: null, now: "2026-01-01T00:00:00Z" });

export function libraryEvidence(): Map<string, Invocation[]> {
  return new Map<string, Invocation[]>([
    ["borrow", [{
      id: "borrow#0", outcome: "committed", rolledBackAttempts: 0, snapshot: null, inputs: inputs({ book_id: "B-1", member_id: "M-1" }),
      delta: {
        stores: {
          loans: { inserted: [{ row: 1, after: { id: "LN-1", book_id: "B-1", member_id: "M-1", state: "ACTIVE", due_date: "2026-01-15" } }], updated: [], deleted: [] },
          books: { inserted: [], updated: [{ row: 1, changes: { state: { before: "AVAILABLE", after: "ON_LOAN" } } }], deleted: [] },
          members: { inserted: [], updated: [{ row: 1, changes: { open_loans: { before: 0, after: 1 } } }], deleted: [] },
          audit_log: { inserted: [{ row: 1, after: { id: 1, action: "BORROW" } }], updated: [], deleted: [] },
        },
        events: ["loan.created"],
      },
    }]],
    ["return", [{
      id: "return#0", outcome: "committed", rolledBackAttempts: 0, snapshot: null, inputs: inputs({ loan_id: "LN-1" }),
      delta: {
        stores: {
          loans: { inserted: [], updated: [{ row: 1, changes: { state: { before: "ACTIVE", after: "RETURNED" }, return_condition: { before: null, after: "GOOD" } } }], deleted: [] },
          books: { inserted: [], updated: [{ row: 1, changes: { state: { before: "ON_LOAN", after: "AVAILABLE" } } }], deleted: [] },
          members: { inserted: [], updated: [{ row: 1, changes: { open_loans: { before: 1, after: 0 } } }], deleted: [] },
          audit_log: { inserted: [{ row: 2, after: { id: 2, action: "RETURN" } }], updated: [], deleted: [] },
        },
        events: ["loan.returned"],
      },
    }]],
  ]);
}
