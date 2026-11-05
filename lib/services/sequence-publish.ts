import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { activateInstantlyCampaign, getInstantlyCampaign, patchInstantlySequences, type InstantlyStep } from "@/lib/services/instantly";
import { findFollowupsToWrite } from "@/lib/services/followup-schedule";
import type { BatchBudget } from "@/lib/services/batch-budget";

/**
 * Publish a campaign's sequence to Instantly — but only once the emails exist.
 *
 * The order matters more than anything else here. Instantly acts on a schedule
 * change within seconds; generating a few hundred personalised follow-ups takes
 * about an hour. Patching first therefore means Instantly finds a pile of newly
 * overdue steps and sends its own generic fallback to every one of them before
 * a single real email has been written.
 *
 * So: save locally, leave Instantly on the old schedule, write the text, and
 * publish last. A campaign in that waiting state keeps sending on its OLD
 * timings, which is the safe place to be — late is recoverable, boilerplate to
 * three hundred customers is not.
 */

/** Stop starting new campaigns once this much of the invocation is gone.
 *
 *  A campaign fans out to one Instantly sub-campaign per country per sender, so
 *  publishing nine campaigns meant about a hundred sequential PATCH calls — and
 *  the whole request died on the 55s function ceiling before a single flag was
 *  cleared. Measured 28 Aug 2026: 504 FUNCTION_INVOCATION_TIMEOUT. Unbudgeted,
 *  this would simply never have published in production.
 *
 *  Publishing is resumable by design: the flag stays set until a campaign is
 *  fully patched, so stopping early costs a wait, not correctness. */
const PUBLISH_BUDGET_MS = 30_000;

export type PublishResult = {
  published: string[];
  waiting: { campaignId: string; missing: number }[];
  failed: { campaignId: string; error: string }[];
};

/** Follow-ups that the NEW schedule makes due but which have no text yet. Zero
 *  means it is safe to let Instantly see the change. */
export async function countMissingText(
  db: SupabaseClient,
  campaignId: string,
): Promise<number> {
  // Only this campaign: the same answer as filtering a whole sweep, without
  // reading every other campaign (and without the 5000 cap cutting it short).
  const targets = await findFollowupsToWrite(db, { limit: 5000, campaignIds: [campaignId] });
  return targets.length;
}

/**
 * A publish that keeps failing (a sub-campaign deleted in Instantly, a payload
 * it rejects) used to be retried every minute for ever, each time running the
 * whole follow-up writer. Now: wait 1, 5, 15, then 60 minutes between tries,
 * and stop after PUBLISH_MAX_FAILURES until the user saves the Sequences again
 * (a save stamps a new sequence_publish_requested_at, which starts the count
 * over). Each failure is an enrichment_logs row, which is also what puts the
 * amber "Follow-up schedule" banner up (service-health.ts).
 */
export const PUBLISH_FAILED_EVENT = "SEQUENCE_PUBLISH_FAILED";
export const PUBLISHED_EVENT = "SEQUENCE_PUBLISHED";
export const PUBLISH_MAX_FAILURES = 5;
const PUBLISH_BACKOFF_MIN = [1, 5, 15, 60];

/** Earliest time the next publish try may run; null = gave up. */
export function nextPublishTryAt(failures: number, lastFailedAt: number): number | null {
  if (failures <= 0) return 0;
  if (failures >= PUBLISH_MAX_FAILURES) return null;
  return lastFailedAt + PUBLISH_BACKOFF_MIN[Math.min(failures, PUBLISH_BACKOFF_MIN.length) - 1] * 60_000;
}

type PendingRow = { id: string; company_id: string; name?: string | null; sequence_publish_requested_at: string | null };

/** Failures since each campaign's latest save: { count, last } per campaign id. */
async function publishFailures(db: SupabaseClient, pending: PendingRow[]) {
  const out = new Map<string, { count: number; last: number }>();
  if (!pending.length) return out;
  const since = (c: PendingRow) => Date.parse(c.sequence_publish_requested_at ?? "1970-01-01T00:00:00Z");
  const { data } = await db
    .from("enrichment_logs")
    .select("payload, created_at")
    .eq("event", PUBLISH_FAILED_EVENT)
    .gte("created_at", new Date(Math.min(...pending.map(since))).toISOString())
    .in("payload->>campaign_id", pending.map((c) => c.id));
  const byId = new Map(pending.map((c) => [c.id, c]));
  for (const row of data ?? []) {
    const id = (row.payload as { campaign_id?: string } | null)?.campaign_id;
    const c = id ? byId.get(id) : undefined;
    const at = Date.parse(row.created_at as string);
    if (!c || at < since(c)) continue;
    const f = out.get(c.id) ?? { count: 0, last: 0 };
    out.set(c.id, { count: f.count + 1, last: Math.max(f.last, at) });
  }
  return out;
}

const tryDue = (f: { count: number; last: number } | undefined, now: number) => {
  const at = f ? nextPublishTryAt(f.count, f.last) : 0;
  return at !== null && at <= now;
};

/** Pending campaigns whose next publish try is due now (not backing off, not given up). */
export async function publishableNow<T extends PendingRow>(db: SupabaseClient, pending: T[], now = Date.now()): Promise<T[]> {
  const failures = await publishFailures(db, pending);
  return pending.filter((c) => tryDue(failures.get(c.id), now));
}

/**
 * Publish every campaign that is waiting and now ready.
 *
 * Called after each follow-up writing pass, so a deferred change goes live the
 * moment the last email lands rather than waiting for anyone to come back and
 * press a button.
 *
 * `budget`: the request's shared clock (write-followups route), so publishing
 * never starts a campaign the request has no time left for.
 */
export async function publishReadySequences(
  rootDb?: SupabaseClient,
  opts: { budget?: BatchBudget } = {},
): Promise<PublishResult> {
  const db = rootDb ?? createAdminClient();
  const result: PublishResult = { published: [], waiting: [], failed: [] };

  const { data: pendingRows } = await db
    .from("campaigns")
    .select("id, company_id, name, sequence_publish_requested_at")
    .eq("sequence_publish_pending", true)
    .eq("is_deleted", false);

  if (!pendingRows?.length) return result;
  const failuresBefore = await publishFailures(db, pendingRows as PendingRow[]);
  const now = Date.now();
  const pending = (pendingRows as PendingRow[]).filter((c) => tryDue(failuresBefore.get(c.id), now));
  if (!pending.length) return result;

  // One sweep for every pending campaign rather than one per campaign, and
  // only over those campaigns rather than every live one.
  const allTargets = await findFollowupsToWrite(db, { limit: 5000, campaignIds: pending.map((c) => c.id) });
  const missingByCampaign = new Map<string, number>();
  for (const t of allTargets) {
    missingByCampaign.set(t.campaignId, (missingByCampaign.get(t.campaignId) ?? 0) + 1);
  }

  const startedAt = Date.now();
  for (const c of pending) {
    // Out of runway. The remaining campaigns keep their flag and are picked up
    // by the next pass — a campaign is never left half-patched, because
    // publishSequenceNow only clears the flag once every sub-campaign took it.
    if (Date.now() - startedAt > PUBLISH_BUDGET_MS) break;
    if (opts.budget && !opts.budget.hasRoomForAnother()) break;
    const campaignId = c.id;
    const missing = missingByCampaign.get(campaignId) ?? 0;
    if (missing > 0) {
      result.waiting.push({ campaignId, missing });
      continue;
    }

    const failures = failuresBefore.get(campaignId)?.count ?? 0;
    try {
      await publishSequenceNow(db, campaignId);
      result.published.push(campaignId);
      // A success after failures takes the banner down again.
      if (failures > 0) await logPublish(db, c, PUBLISHED_EVENT, null);
    } catch (e) {
      // Left pending on purpose: a failed patch must be retried, not silently
      // dropped, or the campaign runs forever on a schedule the user changed.
      const error = (e as Error).message;
      result.failed.push({ campaignId, error });
      const n = failures + 1;
      await logPublish(db, c, PUBLISH_FAILED_EVENT,
        `"${c.name ?? "A campaign"}": the new follow-up schedule could not be sent to Instantly (try ${n} of ${PUBLISH_MAX_FAILURES}): ${error.slice(0, 300)}. `
        + (n >= PUBLISH_MAX_FAILURES
          ? "Stopped retrying: Instantly still runs the old schedule. Save the Sequences again to retry."
          : "It will retry automatically."));
    }
  }

  return result;
}

async function logPublish(db: SupabaseClient, c: PendingRow, event: string, error: string | null) {
  try {
    await db.from("enrichment_logs").insert({
      source: "instantly", event, error, company_id: c.company_id,
      payload: { campaign_id: c.id }, created_at: new Date().toISOString(),
    });
  } catch { /* logging must not break publishing */ }
}

/** Push our steps to every Instantly sub-campaign and clear the pending flag. */
export async function publishSequenceNow(
  db: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const { data: steps } = await db
    .from("campaign_steps")
    .select("step_order, subject, body, delay, delay_unit")
    .eq("campaign_id", campaignId)
    .order("step_order");

  const payload: InstantlyStep[] = (steps ?? []).map((s) => ({
    subject: (s.subject as string) ?? "",
    body: (s.body as string) ?? "",
    delay: (s.delay as number) ?? 0,
    delayUnit: ((s.delay_unit as string) ?? "days") as InstantlyStep["delayUnit"],
  }));
  if (payload.length === 0) return;

  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("instantly_campaign_id")
    .eq("campaign_id", campaignId)
    .not("instantly_campaign_id", "is", null);

  // Every sub-campaign must take the change or the campaign ends up running two
  // different schedules by country. A single failure keeps the flag set so the
  // next pass retries the lot.
  // Whether a finished sub-campaign may be switched back on (see
  // shouldReopenCompleted): read once, before any sub is touched.
  const { data: master } = await db
    .from("campaigns")
    .select("status, is_deleted, sending_held_at")
    .eq("id", campaignId)
    .maybeSingle();

  for (const sub of subs ?? []) {
    const instantlyId = sub.instantly_campaign_id as string;
    await patchInstantlySequences(instantlyId, payload);

    // INSTANTLY CLOSES A CAMPAIGN ONCE EVERY LEAD HAS HAD ITS LAST STEP, and a
    // closed ("Completed") campaign sends nothing, not even a step added later.
    // On 29 Sep 2026 the client added follow-up 3 to PACKAGING GROUP 1: Kuber
    // wrote all 93 and published the new sequence, and all six country
    // campaigns sat Completed and silent until they were switched on by hand.
    // A new follow-up on a campaign that still exists means "send it", so a
    // Completed sub is reopened here, after the text is in place.
    const current = await getInstantlyCampaign(instantlyId).catch(() => null);
    if (shouldReopenCompleted(current?.status, master)) {
      await activateInstantlyCampaign(instantlyId);
    }
  }

  await db.from("campaigns").update({
    sequence_publish_pending: false,
    sequence_publish_requested_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", campaignId);
}

/** Instantly's campaign status for "every lead has finished the sequence". */
export const INSTANTLY_STATUS_COMPLETED = 3;

/**
 * Reopen a sub-campaign Instantly has closed as Completed?
 *
 * Yes, unless a person stopped the campaign on purpose. Deleted, paused and
 * held are all deliberate, and a sequence edit must never undo them; only
 * Instantly's own automatic "all done" is reversed. Any other Instantly state
 * (active, paused by a person in Instantly) is left exactly as it is.
 */
export function shouldReopenCompleted(
  instantlyStatus: number | null | undefined,
  master: { status?: string | null; is_deleted?: boolean | null; sending_held_at?: string | null } | null | undefined,
): boolean {
  if (instantlyStatus !== INSTANTLY_STATUS_COMPLETED || !master) return false;
  if (master.is_deleted) return false;
  if (master.sending_held_at) return false;
  return master.status === "active";
}
