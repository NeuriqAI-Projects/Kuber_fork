import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { TERMINAL_STATUS_LIST } from "@/lib/services/enrichment-status";

// A website that timed out or errored a few hours ago might just work now —
// unlike Apollo's "no email" answer (permanent, re-asking wastes a credit for
// the same non-answer), a site being temporarily down/slow is exactly the
// kind of failure worth trying again later. Meant to run every few hours
// (much less often than the enrichment-watchdog's 15-20 min "did the relay
// die?" check) since there's no urgency — this is opportunistic, not a stall
// recovery.
//
// Deliberately narrower than the manager-facing "Retry all" button:
// - Excludes NO_DOMAIN / NO_EMAILED_LEADS — retrying those changes nothing,
//   there's no new data for a fresh attempt to find.
// - Only orgs that failed a while ago (3h+), so this never fights with a
//   manual retry or the watchdog's own resumption of an active run.
// - Caps an org at MAX_TOTAL_ATTEMPTS enrichment attempts for its whole life.
//   This used to reset enrichment_attempts to 0 on every pass, on the theory
//   that a real gap earns a fresh set of tries — but that defeated scrape-orgs'
//   own 3-attempt cap completely: an org already parked at
//   ENRICHMENT_FAILED_PERMANENT got resurrected, handed 3 fresh attempts, and
//   failed again every 3h indefinitely (35 orgs sat in that loop on 2026-07-23,
//   and a single run requeued 62 orgs — ~5% of the table doing nothing but
//   repeat work). Letting the count accumulate instead means a site that stays
//   broken is tried 3 times, spaced 3h+ apart, and then left alone for good.
//   "Retry all" and per-org rescrape still zero the counter, so a human can
//   always override — that is the deliberate manual escape hatch.
const STALE_FAILURE_HOURS = 3;
const MAX_TOTAL_ATTEMPTS = 3;

// Normally run by the pg_cron job of the same name as ONE SQL statement (see
// supabase/migrations/2026_11_05_auto_retry_failed_orgs_sql.sql); this route is
// kept for manual runs and must follow the same rules. At most BATCH orgs per
// run, ids sent in chunks so the URL stays small (1,000 ids = a 39 KB URL the
// gateway rejected with HTTP 400).
const BATCH = 200;
const ID_CHUNK = 150;

async function autoRetryStaleFailures(req: NextRequest) {
  const db = createAdminClient();
  const staleBefore = new Date(Date.now() - STALE_FAILURE_HOURS * 60 * 60 * 1000).toISOString();

  // Over-fetch: some candidates have no usable lead and are dropped below.
  const { data: candidates, error } = await db
    .from("organizations")
    .select("id")
    .eq("enrichment_stage", "failed")
    .not("enrichment_status", "in", TERMINAL_STATUS_LIST)
    .not("domain", "is", null)
    .lt("enrichment_attempts", MAX_TOTAL_ATTEMPTS)
    .lt("updated_at", staleBefore)
    .limit(BATCH * 5);

  if (error) return fail(500, "INTERNAL", error.message);

  // Only orgs that still have someone worth contacting — same guard scrape-orgs
  // itself applies before spending credits. One leads query per chunk.
  const ids = (candidates ?? []).map((o) => o.id);
  const usable = new Set<string>();
  for (let i = 0; i < ids.length && usable.size < BATCH; i += ID_CHUNK) {
    const { data: leads, error: leadsError } = await db
      .from("leads")
      .select("organization_id")
      .in("organization_id", ids.slice(i, i + ID_CHUNK))
      .eq("is_deleted", false)
      .or("email.not.is.null,has_email.eq.true");
    if (leadsError) return fail(500, "INTERNAL", leadsError.message);
    for (const l of leads ?? []) if (l.organization_id) usable.add(l.organization_id);
  }
  const withUsableLead = [...usable].slice(0, BATCH);

  if (withUsableLead.length === 0) return ok({ requeued: 0 });

  const requeuedIds: string[] = [];
  for (let i = 0; i < withUsableLead.length; i += ID_CHUNK) {
    const { data: updated, error: updateError } = await db
      .from("organizations")
      .update({
        has_scraped: false,
        enrichment_stage: "queued",
        enrichment_status: "SCRAPE_QUEUED",
        // enrichment_attempts is deliberately left alone: it is the lifetime
        // budget this job now respects. markFailed() keeps incrementing it and
        // parks the org at ENRICHMENT_FAILED_PERMANENT on reaching the cap, which
        // the filter above then excludes from every future pass.
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .in("id", withUsableLead.slice(i, i + ID_CHUNK))
      .select("id");
    if (updateError) return fail(500, "INTERNAL", updateError.message);
    requeuedIds.push(...(updated ?? []).map((o) => o.id));
  }
  if (requeuedIds.length === 0) return ok({ requeued: 0 });

  await db.from("enrichment_logs").insert({
    source: "system",
    event: "SCRAPE_QUEUED",
    payload: { total_orgs: requeuedIds.length, triggered_by: "auto_retry_stale_failures" },
    created_at: new Date().toISOString(),
  });

  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  return ok({ requeued: requeuedIds.length });
}

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  return autoRetryStaleFailures(req);
}

/** GET for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`), same pattern as the other internal jobs. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) {
    return fail(401, "UNAUTHORIZED", "Cron authorization required");
  }
  return autoRetryStaleFailures(req);
}
