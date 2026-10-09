// The client's decisions on scored companies (Organizations tab). Each is one
// conditional UPDATE: it only applies while the company is still in an allowed
// state, so a double click, a stale screen or two people at once can't
// double-act (e.g. approve, i.e. pay for, the same company twice).
import type { SupabaseClient } from "@supabase/supabase-js";

export const DECISIONS = {
  approve: { from: ["review", "flagged", "hidden"], to: "approved" },             // reveal one contact (1 Apollo credit)
  reject: { from: ["review", "flagged", "site_down", "good", "waiting_credits", "hidden"], to: "rejected" },
  retry: { from: ["site_down"], to: "queued" },                                   // read the website again (1 Firecrawl credit)
  // Take a decline back. The previous status is not stored, so the company returns to
  // "Needs review" (the client decides again) rather than to where it came from.
  undo: { from: ["rejected"], to: "review" },
} as const;

export type DecisionAction = keyof typeof DECISIONS;

/** Returns the ids that actually changed; the rest had already moved on. */
export async function decide(db: SupabaseClient, userId: string, ids: string[], action: DecisionAction): Promise<string[]> {
  const rule = DECISIONS[action];
  const { data, error } = await db.from("prospect_companies")
    .update({ status: rule.to, attempts: 0, last_error: null, locked_until: null, decided_by: userId, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("id", ids).in("status", [...rule.from])
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as string);
}
