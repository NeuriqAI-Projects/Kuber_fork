import type { SupabaseClient } from "@supabase/supabase-js";
import { onlyRevealedLeads } from "@/lib/server/lead-visibility";

export type ImportRow = {
  id: string;
  label: string;
  source: string;
  lead_count: number;
  color: string;
  created_at: string;
  [key: string]: unknown;
};

/**
 * Company import batches for the Leads filter dropdown.
 *
 * Managers see every batch. Employees only see batches that still contain at
 * least one revealed lead assigned to them — otherwise the filter lists
 * company-wide imports they cannot open any rows for.
 *
 * When `assignedTo` is set, `lead_count` is rewritten to that employee's
 * assigned count so the badge matches what they actually see after filtering.
 */
export async function getImports(
  db: SupabaseClient,
  opts?: { assignedTo?: string },
): Promise<ImportRow[]> {
  const { data, error } = await db
    .from("imports")
    // Only what the Leads filter and the dashboard batch list read (not the
    // jsonb search_criteria / search_warnings). No limit: every batch stays listed.
    .select("id, label, source, lead_count, color, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const imports = (data ?? []) as ImportRow[];
  if (!opts?.assignedTo) return imports;

  // One grouped count (same predicate as below) instead of one count per import.
  // Falls back to the per-import loop if the function is missing.
  const { data: counts, error: countsError } = await db.rpc("assignee_import_lead_counts", { p_assignee: opts.assignedTo });
  if (!countsError) {
    const byImport = new Map(((counts ?? []) as Array<{ import_id: string; lead_count: number }>)
      .map((r) => [r.import_id, Number(r.lead_count)]));
    return imports
      .filter((imp) => (byImport.get(imp.id) ?? 0) > 0)
      .map((imp) => ({ ...imp, lead_count: byImport.get(imp.id)! }));
  }

  const visible: ImportRow[] = [];
  for (const imp of imports) {
    const { count } = await onlyRevealedLeads(
      db
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("import_id", imp.id)
        .eq("assigned_to", opts.assignedTo)
        .eq("is_deleted", false),
    );
    const n = count ?? 0;
    if (n > 0) visible.push({ ...imp, lead_count: n });
  }
  return visible;
}
