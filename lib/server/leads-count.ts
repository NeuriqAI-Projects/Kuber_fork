import type { SupabaseClient } from "@supabase/supabase-js";
import { onlyRevealedLeads } from "@/lib/server/lead-visibility";

/** Takes the caller's company-scoped client — counting every tenant's leads
 *  here would put Company A's total in Company B's sidebar. Pre-reveal rows are
 *  excluded for the same reason they are hidden from the list itself. */
export async function getLeadsCount(db: SupabaseClient, opts?: { assignedTo?: string }): Promise<number> {
  const { count, error } = await onlyRevealedLeads(
    db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("is_deleted", false)
      .match(opts?.assignedTo ? { assigned_to: opts.assignedTo } : {})
  );
  if (error) return 0;
  return count ?? 0;
}

export const LEAD_DB_STATUSES = ["new", "enriching", "enriched", "input_required", "open", "closed"] as const;
export type LeadDbStatus = (typeof LEAD_DB_STATUSES)[number];

/**
 * Live count per pipeline stage, counted BY THE DATABASE.
 *
 * Both the Dashboard and the Kanban board used to tally these in JavaScript —
 * the Dashboard by fetching every lead's status, the board by grouping the ~500
 * rows the browser happened to have loaded. PostgREST caps a response at 1,000
 * rows and reports nothing when it truncates, so the two surfaces disagreed
 * with each other AND with reality: the same account showed 999 leads on the
 * Dashboard and 500 across the Kanban columns. A count belongs in the database;
 * six indexed head-counts cannot be truncated and cannot drift apart.
 */
export async function getLeadStatusCounts(
  db: SupabaseClient,
  opts?: { assignedTo?: string },
): Promise<Record<LeadDbStatus, number>> {
  const entries = await Promise.all(
    LEAD_DB_STATUSES.map(async (status) => {
      let q = db.from("leads").select("id", { count: "exact", head: true }).eq("is_deleted", false).eq("status", status);
      if (opts?.assignedTo) q = q.eq("assigned_to", opts.assignedTo);
      const { count } = await onlyRevealedLeads(q);
      return [status, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<LeadDbStatus, number>;
}

/** Leads created in each of the given months, counted by the database.
 *  Same reason as above: the growth chart used to fetch six months of rows and
 *  bucket them in JS, so it flattened out at the 1,000-row cap. */
export async function getLeadMonthlyCounts(
  db: SupabaseClient,
  monthStarts: Date[],
  opts?: { assignedTo?: string },
): Promise<number[]> {
  return Promise.all(
    monthStarts.map(async (start) => {
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      let q = db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("is_deleted", false)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString());
      if (opts?.assignedTo) q = q.eq("assigned_to", opts.assignedTo);
      const { count } = await onlyRevealedLeads(q);
      return count ?? 0;
    }),
  );
}
