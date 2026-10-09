// One worker pass for one client company: load its fit rules, pick real or
// mock services, advance prospects until the time budget is spent.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createScopedClient } from "@/lib/supabase/scoped";
import { parseFitScoring } from "./fit-rules";
import { isMockProspecting, mockDeps, realDeps } from "./deps";
import { runBatch, WORKABLE } from "./pipeline";
import { supabaseStore } from "./store";

/** Measured 9 Oct 2026 (200 real companies): a 45 s budget let runs reach 57–61 s,
 *  past the 60 s route limit. So: no new company after 30 s, and no paid website
 *  read may START after 35 s (a slow read takes ~15 s). Runs end well inside 60 s. */
export const WORKER_BUDGET_MS = 30_000;
export const WORKER_PAID_START_MS = 35_000;
/** Companies worked on at once. Firecrawl is separately capped at 4 (deps.ts); Jev allows 40 requests/s. */
export const WORKER_LANES = 8;

export interface BatchInfo {
  /** The Leads batch this search's revealed contacts join. */
  importId: string | null;
  /** Who started the search: recorded as the lead's creator (leads.created_by is required). */
  createdBy: string | null;
}

/** The Leads batch a search's promoted contacts join — created on first use, once. */
function batchFor(companyId: string) {
  const db = createScopedClient(companyId);
  return async (searchId: string): Promise<BatchInfo> => {
    const { data: s } = await db.from("prospect_searches").select("import_id, created_at, created_by, filters").eq("id", searchId).maybeSingle();
    if (!s) return { importId: null, createdBy: null };
    const createdBy = (s.created_by as string | null) ?? null;
    if (s.import_id) return { importId: s.import_id as string, createdBy };
    // The batch name/colour the manager typed when starting the search.
    const f = (s.filters ?? {}) as { batch_name?: string; color?: string; assigned_to?: string | null; assignment_strategy?: string };
    const label = f.batch_name?.trim() || `Scored search ${new Date(s.created_at as string).toISOString().slice(0, 10)}`;
    // Assignment is stored on the batch and applied when each lead is ready to
    // work (deferred assignment, lib/services/assignment.ts) — same as company-import.
    const { data: imp } = await db.from("imports").insert({
      label, source: "apollo", created_by: createdBy, lead_count: 0, color: f.color ?? "green",
      assignment_strategy: f.assigned_to ? "manual" : (f.assignment_strategy ?? null),
      assignment_target: f.assigned_to ?? null,
    }).select("id").single();
    if (!imp) return { importId: null, createdBy };
    // Only the first writer wins; a racing second run reads the winner back.
    await db.from("prospect_searches").update({ import_id: imp.id }).eq("id", searchId).is("import_id", null);
    const { data: again } = await db.from("prospect_searches").select("import_id").eq("id", searchId).maybeSingle();
    if (again?.import_id !== imp.id) await db.from("imports").delete().eq("id", imp.id);
    return { importId: (again?.import_id as string) ?? null, createdBy };
  };
}

export async function runProspectWorker(admin: SupabaseClient, companyId: string, budgetMs = WORKER_BUDGET_MS) {
  const scoped = createScopedClient(companyId);
  const { data: setting } = await scoped.from("settings").select("value").eq("key", "fit_scoring").maybeSingle();
  const cfg = parseFitScoring(setting?.value ?? null);
  const imp = batchFor(companyId);
  const deps = isMockProspecting(companyId) ? mockDeps(companyId, imp) : realDeps(admin, companyId, imp);
  return runBatch(deps, supabaseStore(admin, companyId), cfg, { budgetMs, lanes: WORKER_LANES, paidStartMs: budgetMs + (WORKER_PAID_START_MS - WORKER_BUDGET_MS) });
}

/** Companies that currently have work waiting (for the cron pump). */
export async function companiesWithWork(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin.from("prospect_companies").select("company_id").in("status", WORKABLE).limit(1000);
  return [...new Set((data ?? []).map((r) => r.company_id as string))];
}
