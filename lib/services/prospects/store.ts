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
    async reserveAutoReveal(searchId, defaultCap) {
      const { data, error } = await db.rpc("reserve_auto_reveal", { p_search: searchId, p_default_cap: defaultCap });
      if (error) throw new Error(`reserve_auto_reveal: ${error.message}`);
      return data === true;
    },
  };
}
