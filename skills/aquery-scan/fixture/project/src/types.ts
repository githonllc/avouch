// Domain records, one per table.
export interface Tool {
  id: string;
  name: string;
  state: "IN_STOCK" | "LENT" | "RETIRED";
}

export interface Member {
  id: string;
  display_name: string;
  safety_briefing_at: string | null;
  suspended: boolean;
}

export interface Rental {
  id: string;
  tool_id: string;
  member_id: string;
  state: "OPEN" | "CLOSED";
  opened_at: string;
  closed_at?: string;
}
