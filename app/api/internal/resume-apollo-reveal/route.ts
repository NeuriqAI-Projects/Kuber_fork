import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { triggerEnrichWatchdog } from "@/lib/services/enrichment-watchdog";
import { withRouteTiming } from "@/lib/services/route-timing";

export const maxDuration = 60;

/**
 * The only scheduled job in the app that can spend money.
 *
 * It finishes the Apollo email-reveal for imports whose own self-chain died
 * part-way — a redeploy, a crash, or a batch killed by the function time limit.
 * Those leads were never asked about, so the credit it spends is their first,
 * not a repeat.
 *
 * It is a SEPARATE route on a SEPARATE schedule (once a day) precisely because
 * it costs money. It used to ride along inside the 15-minute enrichment
 * watchdog, which meant any defect in the reveal path got 96 chances a day to
 * become a charge — that is how a single unresolvable lead ran up ~420 credits
 * between 15 and 26 July 2026 before anyone noticed. Once a day, the same
 * defect costs 1 credit a day and is obvious in the usage log long before it
 * matters.
 *
 * The delay costs nothing real: a healthy import chains itself through in
 * seconds and never reaches this job at all. This only exists for the case
 * where that chain broke, and a lead that arrives a day later is still a lead.
 */
export const POST = withRouteTiming("internal/resume-apollo-reveal", async (req) => {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  const db = createAdminClient();
  await triggerEnrichWatchdog(internalAppBaseUrl(req), db);
  return ok({ triggered: true });
});

/** GET for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`), same pattern as
 *  the enrichment watchdog and reconcile-counters. */
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
  await triggerEnrichWatchdog(internalAppBaseUrl(req), db);
  return ok({ triggered: true });
}
