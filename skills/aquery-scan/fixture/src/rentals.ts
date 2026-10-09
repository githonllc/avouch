import type { Tool, Member, Rental } from "./types";

export type Result = "OPENED" | "CLOSED" | "REJECTED";

export async function openRental(db: D1Database, actor: { perms: string[] }, toolId: string, memberId: string): Promise<Result> {
  if (!actor.perms.includes("rental:write")) throw new Error("forbidden");
  const tool = await db.prepare("SELECT * FROM tools WHERE id = ?").bind(toolId).first<Tool>();
  if (!tool || tool.state !== "IN_STOCK") return "REJECTED";
  const member = await db.prepare("SELECT * FROM members WHERE id = ?").bind(memberId).first<Member>();
  if (!member || member.suspended) return "REJECTED";
  await db.batch([
    db.prepare("INSERT INTO rentals (id, tool_id, member_id, state, opened_at) VALUES (?, ?, ?, 'OPEN', datetime('now'))").bind(crypto.randomUUID(), toolId, memberId),
    db.prepare("UPDATE tools SET state = 'LENT' WHERE id = ?").bind(toolId),
    db.prepare("INSERT INTO events (type, ref) VALUES ('rental.opened', ?)").bind(toolId),
  ]);
  return "OPENED";
}

export async function closeRental(db: D1Database, actor: { perms: string[] }, rentalId: string): Promise<Result> {
  if (!actor.perms.includes("rental:write")) throw new Error("forbidden");
  const rental = await db.prepare("SELECT * FROM rentals WHERE id = ?").bind(rentalId).first<Rental>();
  if (!rental || rental.state !== "OPEN") return "REJECTED";
  await db.batch([
    db.prepare("UPDATE rentals SET state = 'CLOSED', closed_at = datetime('now') WHERE id = ?").bind(rentalId),
    db.prepare("UPDATE tools SET state = 'IN_STOCK' WHERE id = ?").bind(rental.tool_id),
    db.prepare("INSERT INTO events (type, ref) VALUES ('rental.closed', ?)").bind(rentalId),
  ]);
  return "CLOSED";
}
