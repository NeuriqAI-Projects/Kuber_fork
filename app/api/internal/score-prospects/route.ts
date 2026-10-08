import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { companiesWithWork, runProspectWorker, WORKER_BUDGET_MS } from "@/lib/services/prospects/worker";

export const maxDuration = 60;

/**
 * Prospect scoring pump (pg_cron, every minute — see
 * supabase/migrations/2026_10_08_prospect_scoring_pump_cron.sql).
 *
 * Cross-company on purpose: it walks every company with waiting prospects and
 * runs each one with that company's own keys, rules and scoped writes. The
 * shared time budget is split so one busy company can't starve another.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  const admin = createAdminClient();
  const companies = await companiesWithWork(admin);
  const results: Record<string, number | string> = {};
  const share = companies.length ? Math.max(5_000, Math.floor(WORKER_BUDGET_MS / companies.length)) : 0;
  for (const companyId of companies) {
    try {
      results[companyId] = (await runProspectWorker(admin, companyId, share)).advanced;
    } catch (err) {
      results[companyId] = `error: ${(err as Error).message.slice(0, 200)}`;
    }
  }
  return ok({ companies: companies.length, results });
}
