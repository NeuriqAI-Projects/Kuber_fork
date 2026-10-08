// Supabase-backed Store for the prospect pipeline (cross-company worker, so the
// admin client, always filtered by the company_id it was built for).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProspectPatch, ProspectRow, Store } from "./pipeline";

export function supabaseStore(db: SupabaseClient, companyId: string): Store {
  return {
    async claim(limit) {
      const { data, error } = await db.rpc("claim_prospects", { p_company: companyId, p_limit: limit });
      if (error) throw new Error(`claim_prospects: ${error.message}`);
      return (data ?? []) as ProspectRow[];
    },
    async save(id: string, patch: ProspectPatch) {
      const { retry_at, ...rest } = patch;
      const { error } = await db
        .from("prospect_companies")
        .update({ ...rest, locked_until: retry_at ? new Date(retry_at).toISOString() : null, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("company_id", companyId);
      if (error) throw new Error(`save prospect: ${error.message}`);
    },
    async autoReveals(searchId) {
      const [{ count }, { data: s }] = await Promise.all([
        db.from("prospect_companies").select("id", { count: "exact", head: true })
          .eq("company_id", companyId).eq("search_id", searchId).eq("auto_reveal", true),
        db.from("prospect_searches").select("filters").eq("id", searchId).eq("company_id", companyId).maybeSingle(),
      ]);
      const cap = (s?.filters as { max_auto_reveals?: number } | null)?.max_auto_reveals;
      return { used: count ?? 0, cap: typeof cap === "number" ? cap : null };
    },
  };
}
