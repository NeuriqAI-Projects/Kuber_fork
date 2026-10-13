// The client's decisions on scored companies (Organizations tab). Each is a
// conditional UPDATE: it only applies while the company is still in an allowed
// state, so a double click, a stale screen or two people at once can't
// double-act (e.g. approve, i.e. pay for, the same company twice).
import type { SupabaseClient } from "@supabase/supabase-js";

export const DECISIONS = {
  approve: { from: ["review", "flagged", "hidden"], to: "approved" },             // reveal one contact (1 Apollo credit)
  reject: { from: ["review", "flagged", "site_down", "good", "waiting_credits", "hidden"], to: "rejected" },
  retry: { from: ["site_down"], to: "queued" },                                   // read the website again (1 Firecrawl credit)
  // Take a decline back: the company returns to where it was (declined_from).
  // Rows declined before that column existed go to "Needs review".
  undo: { from: ["rejected"], to: "review" },
} as const;

export type DecisionAction = keyof typeof DECISIONS;

/** Returns the ids that actually changed; the rest had already moved on. */
export async function decide(db: SupabaseClient, userId: string, ids: string[], action: DecisionAction): Promise<string[]> {
  const now = new Date().toISOString();
  const stamp = { attempts: 0, last_error: null, locked_until: null, decided_by: userId, decided_at: now, updated_at: now };
  // One conditional update per starting status. Each row is still changed at
  // most once (the status check), and each group is told exactly where it was.
  const move = async (rowIds: string[], from: string, patch: Record<string, unknown>) => {
    if (!rowIds.length) return [];
    const { data, error } = await db.from("prospect_companies").update(patch).in("id", rowIds).eq("status", from).select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.id as string);
  };

  if (action === "reject") {
    // Remember where each one was, so Undo can put it back (Hidden stays Hidden).
    const done = await Promise.all(DECISIONS.reject.from.map((from) => move(ids, from, { ...stamp, status: "rejected", declined_from: from })));
    return done.flat();
  }

  if (action === "undo") {
    const { data, error } = await db.from("prospect_companies").select("id, declined_from").in("id", ids).eq("status", "rejected");
    if (error) throw new Error(error.message);
    const byTarget = new Map<string, string[]>();
    for (const r of data ?? []) {
      const to = (r.declined_from as string | null) ?? DECISIONS.undo.to;
      byTarget.set(to, [...(byTarget.get(to) ?? []), r.id as string]);
    }
    // Back to how it was: an automatic Good fit is not "approved by" anyone.
    const done = await Promise.all([...byTarget].map(([to, rowIds]) =>
      move(rowIds, "rejected", { ...stamp, status: to, declined_from: null, decided_by: null, decided_at: null })));
    return done.flat();
  }

  const rule = DECISIONS[action];
  const { data, error } = await db.from("prospect_companies")
    .update({ ...stamp, status: rule.to })
    .in("id", ids).in("status", [...rule.from])
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as string);
}
