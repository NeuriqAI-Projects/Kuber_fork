import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { runEnrichmentWatchdog } from "@/lib/services/enrichment-watchdog";

// A pass is a few seconds now; never let a hung provider call bill the 300 s default.
export const maxDuration = 60;

// Meant to be hit often (every 10 min, pg_cron) — separate from reconcile-counters'
// daily cron, which was the only safety net before this and left up to a
// day's gap whenever the enrichment self-chain silently died (confirmed live
// this happened: server stayed up, relay just stopped, backlog sat untouched
// for 10+ hours). This is deliberately cheap: two "is there unfinished work?"
// checks, no heavy campaign-counter recompute like reconcile-counters does.
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  const db = createAdminClient();
  await runEnrichmentWatchdog(internalAppBaseUrl(req), db);
  return ok({ triggered: true });
}

/** GET for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`), same pattern as reconcile-counters. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) {
    return fail(401, "UNAUTHORIZED", "Cron authorization required");
  }
  const db = createAdminClient();
  await runEnrichmentWatchdog(internalAppBaseUrl(req), db);
  return ok({ triggered: true });
}
