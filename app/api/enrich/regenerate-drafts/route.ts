import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { safeSecretEqual } from "@/lib/auth/secret";
import { regenerateOneDraft } from "@/lib/services/regenerate-draft";
import { countPendingItems, bulkRegeneratableStatuses } from "@/lib/services/regeneration-jobs";
import { BatchBudget } from "@/lib/services/batch-budget";
import { resumeIfHeldForJob } from "@/lib/services/campaign-lifecycle";

export const maxDuration = 55;

/**
 * Which draft this job item means, resolved NOW rather than at enqueue time —
 * the user may have edited, or the generator replaced it, during the minutes the
 * job sat queued.
 *
 * Step 1 follows campaign_leads.draft_id, which is the pointer to the live
 * opening email. That column tracks ONLY step 1, so a follow-up job must look
 * the draft up by (campaign, lead, step) instead. Using draft_id for a step-2
 * job would have quietly regenerated everyone's opening email when the user
 * clicked Regenerate all on a follow-up.
 */
async function resolveDraftId(
  db: ReturnType<typeof createScopedClient>,
  campaignId: string,
  item: { campaign_lead_id: string; lead_id: string },
  stepNumber: number,
): Promise<string | null> {
  if (stepNumber === 1) {
    const { data: cl } = await db
      .from("campaign_leads")
      .select("draft_id")
      .eq("id", item.campaign_lead_id)
      .maybeSingle();
    return (cl?.draft_id as string | null) ?? null;
  }

  // Excludes 'rejected', which are superseded historical versions rather than
  // the live draft for this step.
  const { data: draft } = await db
    .from("email_drafts")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("lead_id", item.lead_id)
    .eq("step_number", stepNumber)
    .neq("status", "rejected")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (draft?.id as string | null) ?? null;
}

// Regeneration is one LLM call per lead and the single-draft route budgets 60s
// for one of them, so five sequential calls is the safe ceiling for a 55s
// invocation. The job self-chains, so a small batch costs nothing but an extra
// round trip.
// The budget below is the time guard, not this number: an AI run still stops
// after ~5 calls and releases the rest. Raised from 5 because the platform
// drops a self-chain after five hops (see runBatch), so a switched-off
// campaign has to get through its leads in very few batches.
const BATCH_SIZE = 60;

/**
 * Batch worker for bulk draft regeneration.
 *
 * Claims a few pending items, regenerates each through the same routine the
 * single-draft route uses (so version history is identical), then re-triggers
 * itself until the job is finished. Mirrors /api/enrich/generate-drafts.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { job_id?: string };
  const db = createAdminClient();

  // No job_id: the once-a-minute pump (pg_cron 'regeneration-pump'). Pick up
  // whichever live job has gone quiet. The batch-to-batch self-chain below
  // dies on production every few batches — measured 18 Sep 2026: 20 items,
  // stall; kick; 20 more, stall — and the watchdog only looks every ten
  // minutes at jobs five minutes stale, so a 96-lead run crawled for the best
  // part of an hour. A heartbeat under a minute old means a chain is still
  // moving and is left alone.
  let jobId = body.job_id;
  if (!jobId) {
    const quietBefore = new Date(Date.now() - 60_000).toISOString();
    const { data: quiet } = await db
      .from("draft_regeneration_jobs")
      .select("id")
      .in("status", ["queued", "running"])
      .or(`heartbeat_at.is.null,heartbeat_at.lt.${quietBefore}`)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!quiet) return Response.json({ processed: 0, status: "idle" });
    jobId = quiet.id as string;
  }

  // REPLY NOW, WORK AFTER. Each batch used to run inside the request and only
  // then kick the next one — and wait for that whole batch to finish before
  // exiting, so every link in the chain sat waiting on the next. On production
  // the chain died after exactly five links, three runs out of three on
  // 18 Sep 2026, and a 96-lead run crawled for an hour on watchdog revivals.
  // Now the request returns at once and the batch runs in after(); the kick to
  // the next batch returns in under a second the same way, so no link waits.
  const baseUrl = internalAppBaseUrl(req);
  const id = jobId;
  after(() => runBatch(db, id, baseUrl));
  return Response.json({ accepted: true, job_id: id }, { status: 202 });
}

/** One batch of one job, then the kick for the next. Runs after the response. */
async function runBatch(db: ReturnType<typeof createAdminClient>, jobId: string, baseUrl: string) {
  const { data: job } = await db
    .from("draft_regeneration_jobs")
    .select("id, campaign_id, status, custom_instruction, requested_by, succeeded, failed, company_id, step_number, created_at")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return;

  // Internal trigger (shared secret, no user session): the job row supplies the
  // company, and everything below writes through a client scoped to it.
  const cdb = createScopedClient(job.company_id as string);

  // Cancelled between batches — stop without touching anything further.
  if (job.status === "cancelled" || job.status === "completed" || job.status === "failed") return;

  const now = new Date().toISOString();
  if (job.status === "queued") {
    await cdb.from("draft_regeneration_jobs").update({
      status: "running",
      started_at: now,
      heartbeat_at: now,
    }).eq("id", jobId);
  }

  const { data: items } = await cdb
    .from("draft_regeneration_job_items")
    .select("id, campaign_lead_id, lead_id")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (!items || items.length === 0) {
    await finishJob(cdb, jobId);
    return;
  }

  await cdb
    .from("draft_regeneration_job_items")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .in("id", items.map((i) => i.id));
  // Heartbeat at claim time too, so the once-a-minute pump never sees a batch
  // that is mid-flight as "quiet" and starts a second one on the same job.
  await cdb.from("draft_regeneration_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId);

  let succeeded = 0;
  let failed = 0;

  const stepNumber = (job.step_number as number | null) ?? 1;

  // THE PLATFORM ALLOWS ABOUT FIVE SELF-CALLS IN A ROW, THEN DROPS THE NEXT.
  // Measured four times on 18 Sep 2026, with two different hand-off designs:
  // five batches, then silence, every time. So a run has to fit in five
  // batches or wait for something else to kick it. With AI switched off a
  // lead is ~3s of database round trips, one at a time - four at a time is
  // the same work in a quarter of the wall clock, and 100 leads becomes two
  // batches. AI runs stay one at a time: the budget's slowest-call logic and
  // the providers' rate limits both assume it.
  const { data: camp } = await cdb.from("campaigns").select("followups_ai_enabled").eq("id", job.campaign_id as string).maybeSingle();
  const aiOff = stepNumber > 1 && camp?.followups_ai_enabled === false;
  const concurrency = aiOff ? 4 : 1;

  // BATCH_SIZE alone is not a time guard: five calls at the observed 10.5s
  // worst case is 52s against a 55s ceiling, with nothing left for the
  // self-chain. Claimed items that go unprocessed are released below.
  const budget = new BatchBudget();
  const unprocessed: string[] = [];
  const runOne = async (item: { id: string; campaign_lead_id: string; lead_id: string }) => {
    const draftId = await resolveDraftId(cdb, job.campaign_id as string, item, stepNumber);
    if (!draftId) {
      await markItem(cdb, item.id, "skipped", "Lead no longer has a draft for this step");
      return;
    }
    const result = await budget.run(() => regenerateOneDraft(cdb, draftId, {
      userId: job.requested_by ?? undefined,
      customInstruction: job.custom_instruction ?? undefined,
      bulkJobId: jobId,
      // Re-checked per lead, not just at enqueue: a draft certified or sent
      // while the job was queued must not be overwritten by it. Follow-ups
      // widen this to include 'approved' — see bulkRegeneratableStatuses.
      allowedStatuses: bulkRegeneratableStatuses(stepNumber),
    }));
    if (result.ok) {
      await markItem(cdb, item.id, "done", null);
      succeeded++;
    } else if (result.code === "CONFLICT") {
      await markItem(cdb, item.id, "skipped", result.reason);
    } else {
      await markItem(cdb, item.id, "failed", result.reason);
      failed++;
    }
  };
  for (let i = 0; i < items.length; i += concurrency) {
    // Out of runway. Every item from here on was already claimed as 'running'
    // above, so it has to go back to 'pending' or the job stalls holding rows
    // nothing will ever pick up.
    if (!budget.hasRoomForAnother()) {
      for (const it of items.slice(i)) unprocessed.push(it.id as string);
      break;
    }
    await Promise.all(items.slice(i, i + concurrency).map((it) => runOne(it as { id: string; campaign_lead_id: string; lead_id: string })));
  }

  if (unprocessed.length > 0) {
    await cdb.from("draft_regeneration_job_items")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .in("id", unprocessed);
  }

  const { data: fresh } = await cdb
    .from("draft_regeneration_jobs")
    .select("status, succeeded, failed")
    .eq("id", jobId)
    .maybeSingle();

  await cdb.from("draft_regeneration_jobs").update({
    succeeded: (fresh?.succeeded ?? 0) + succeeded,
    failed: (fresh?.failed ?? 0) + failed,
    heartbeat_at: new Date().toISOString(),
  }).eq("id", jobId);

  // Cancellation lands while a batch is in flight; honour it before chaining.
  if (fresh?.status === "cancelled") return;

  const remaining = await countPendingItems(cdb, jobId);

  if (remaining > 0 && process.env.INTERNAL_SECRET) {
    // The next batch answers 202 as soon as it has the job id, so this wait is
    // under a second, not a whole batch. Awaited so the kick leaves the machine
    // before this invocation ends.
    await fetch(`${baseUrl}/api/enrich/regenerate-drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SECRET },
      body: JSON.stringify({ job_id: jobId }),
    }).catch(() => {});
  } else if (remaining === 0) {
    await finishJob(cdb, jobId);
    // The hold this run needed is released by the run itself. See
    // resumeIfHeldForJob for why, and for what it deliberately leaves held.
    await resumeIfHeldForJob(cdb, {
      campaign_id: job.campaign_id as string,
      requested_by: (job.requested_by as string | null) ?? null,
      created_at: job.created_at as string,
    }).catch(() => { /* the banner's Resume button is the fallback */ });
  }

}

async function markItem(
  db: ReturnType<typeof createAdminClient>,
  itemId: string,
  status: "done" | "failed" | "skipped",
  error: string | null,
) {
  await db.from("draft_regeneration_job_items").update({
    status,
    error,
    updated_at: new Date().toISOString(),
  }).eq("id", itemId);
}

/** Close out a job, unless it was cancelled — that status is the user's, not ours to overwrite. */
async function finishJob(db: ReturnType<typeof createAdminClient>, jobId: string) {
  await db.from("draft_regeneration_jobs").update({
    status: "completed",
    finished_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}
