import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Active (not soft-deleted) leads with this email, OLDEST first, with their
 * company. Through a scoped client only that company's rows come back; through
 * the admin client every company's do (at most one each — see the unique
 * index below), which lets a caller look the lead up before it knows the
 * company and pick the right row afterwards.
 *
 * Exact match on the trimmed, lowercased address. Every write path stores
 * leads.email lowercased (checked 2026-11-05: 0 of 12,617 rows had capitals),
 * so this hits `leads_email_idx` (~1.5 ms) where the old ILIKE scanned the
 * whole company (~30-80 ms, 21k calls).
 * ponytail: relies on lowercase storage; if a write path ever stores capitals,
 * add a lower(email) RPC (leads_company_lower_email_active_uidx) instead.
 */
export async function findActiveLeadsByEmail(
  db: SupabaseClient,
  email: string | null | undefined,
): Promise<Array<{ id: string; company_id: string }>> {
  const norm = email?.trim().toLowerCase();
  if (!norm) return [];
  const { data, error } = await db
    .from("leads")
    .select("id, company_id")
    .eq("email", norm)
    .eq("is_deleted", false)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as Array<{ id: string; company_id: string }>;
}

/**
 * Case-insensitive, soft-delete-aware lookup of a lead id by email.
 * Returns the OLDEST active match deterministically, or null.
 *
 * Replaces the fragile `.eq("email", …).maybeSingle()` used for reply
 * attribution, which was case-sensitive and silently returned null — dropping
 * the reply — whenever duplicate emails existed.
 */
export async function findActiveLeadIdByEmail(
  db: SupabaseClient,
  email: string | null | undefined,
): Promise<string | null> {
  return (await findActiveLeadsByEmail(db, email))[0]?.id ?? null;
}
