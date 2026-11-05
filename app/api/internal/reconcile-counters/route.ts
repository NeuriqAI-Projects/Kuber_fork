import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";

export const maxDuration = 60;

// Denormalised campaign counters are incremented by scattered webhook code and
// drift over time (planning.md Phase 6.6). The recompute is one SQL statement,
// public.reconcile_campaign_counters() (supabase/migrations/
// 2026_11_05_B_reconcile_counters_and_indexes.sql), run daily at 02:30 UTC by
// the pg_cron job 'reconcile-campaign-counters'. This route is kept only for a
// manual run; safe any time (idempotent). The enrichment watchdog has its own
// 10-minute pg_cron job, so it no longer piggy-backs on this route.
async function reconcile() {
  const { data, error } = await createAdminClient().rpc("reconcile_campaign_counters");
  if (error) return fail(500, "RECONCILE_FAILED", error.message);
  return ok({ campaigns_corrected: data as number });
}

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  return reconcile();
}

/** GET for a manual run (`Authorization: Bearer <CRON_SECRET>` or x-internal-secret). */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) {
    return fail(401, "UNAUTHORIZED", "Cron authorization required");
  }
  return reconcile();
}
