// One worker pass for one client company: load its fit rules, pick real or
// mock services, advance prospects until the time budget is spent.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createScopedClient } from "@/lib/supabase/scoped";
import { parseFitScoring } from "./fit-rules";
import { isMockProspecting, mockDeps, realDeps } from "./deps";
import { runBatch, WORKABLE } from "./pipeline";
import { supabaseStore } from "./store";

/** Under the 55–60 s route limit with room for one slow stage to finish. */
export const WORKER_BUDGET_MS = 25_000;

/** The Leads batch a search's promoted contacts join — created on first use, once. */
function importIdFor(companyId: string, userId: string | null) {
  const db = createScopedClient(companyId);
  return async (searchId: string): Promise<string | null> => {
    const { data: s } = await db.from("prospect_searches").select("import_id, created_at, created_by, filters").eq("id", searchId).maybeSingle();
    if (!s) return null;
    if (s.import_id) return s.import_id as string;
    // The batch name/colour the manager typed when starting the search.
    const f = (s.filters ?? {}) as { batch_name?: string; color?: string };
    const label = f.batch_name?.trim() || `Scored search ${new Date(s.created_at as string).toISOString().slice(0, 10)}`;
    const { data: imp } = await db.from("imports").insert({ label, source: "apollo", created_by: (s.created_by as string) ?? userId, lead_count: 0, color: f.color ?? "green" }).select("id").single();
    if (!imp) return null;
    // Only the first writer wins; a racing second run reads the winner back.
    await db.from("prospect_searches").update({ import_id: imp.id }).eq("id", searchId).is("import_id", null);
    const { data: again } = await db.from("prospect_searches").select("import_id").eq("id", searchId).maybeSingle();
    if (again?.import_id !== imp.id) await db.from("imports").delete().eq("id", imp.id);
    return (again?.import_id as string) ?? null;
  };
}

export async function runProspectWorker(admin: SupabaseClient, companyId: string, budgetMs = WORKER_BUDGET_MS) {
  const scoped = createScopedClient(companyId);
  const { data: setting } = await scoped.from("settings").select("value").eq("key", "fit_scoring").maybeSingle();
  const cfg = parseFitScoring(setting?.value ?? null);
  const imp = importIdFor(companyId, null);
  const deps = isMockProspecting(companyId) ? mockDeps(companyId, imp) : realDeps(admin, companyId, cfg, imp);
  return runBatch(deps, supabaseStore(admin, companyId), cfg, { budgetMs, batch: 3 });
}

/** Companies that currently have work waiting (for the cron pump). */
export async function companiesWithWork(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin.from("prospect_companies").select("company_id").in("status", WORKABLE).limit(1000);
  return [...new Set((data ?? []).map((r) => r.company_id as string))];
}
