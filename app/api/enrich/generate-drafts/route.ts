import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { after } from "next/server";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { safeSecretEqual } from "@/lib/auth/secret";
import {
  fetchDraftTargets,
  generateOneDraft,
  countPendingDrafts,
  logLlmUnavailable,
  logLlmRecovered,
  isProviderOutage,
  isDraftGenerationStalled,
  canDraftOpenings,
} from "@/lib/services/generate-drafts";
import { isMockCampaign } from "@/lib/services/llm-mock";
import { hasUsableLlmKey } from "@/lib/services/provider-keys";
import { BatchBudget } from "@/lib/services/batch-budget";

export const maxDuration = 55;

// Drafts written at once per batch. One at a time, a Claude draft (~14s) left
// room for 3 per batch, and the batch chain dies after ~5 hops — so a 121-lead
// campaign on 24 Sep 2026 took 1h40m, mostly waiting on watchdog restarts. The
// client's Anthropic key allows 10k requests / 10M input tokens a minute
// (headers read 25 Sep 2026); 6 in flight is ~25 calls a minute. Duplicates are
// impossible: the partial unique index on email_drafts rejects a second
// in-flight row for the same lead (see generateOneDraft).
const DRAFT_CONCURRENCY = 6;

// How long a batch may keep starting new drafts now lives in BatchBudget,
// which measures the calls instead of assuming an average.

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { campaign_id?: string; step_number?: number };
  const campaignId = body.campaign_id;
  const stepNumber = body.step_number ?? 1;
  const db = createAdminClient();

  // No campaign_id: the once-a-minute pump (pg_cron 'draft-generation-pump').
  // The batch chain below dies after ~5 hops on the platform and the watchdog
  // takes 10-20 minutes to notice; this restarts a stopped campaign within a
  // minute whether or not anyone has it open. A campaign still producing
  // drafts is left alone (isDraftGenerationStalled).
  if (!campaignId) return pumpStalledCampaigns(req, db);

  // Self-heal: reset any stuck drafts/campaigns before proceeding
  try { await db.rpc("reset_stuck_draft_generation", { stale_minutes: 5 }); } catch { /* non-fatal */ }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, human_in_loop, status, ai_prompt_context, company_id")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }

  // This route is triggered internally (shared secret, no user session), so it
  // has no company of its own — the campaign it was handed supplies one. Every
  // draft, prompt read and lead update below goes through a client scoped to
  // it, which is also what stamps company_id on the email_drafts rows.
  const cdb = createScopedClient(campaign.company_id as string);

  // Pre-flight: never start work no provider will serve.
  //
  // Every trigger reaches generation through this route — the user's initial
  // "generate drafts", the self-chain below, and the watchdog — so one guard
  // here covers all three. Without it a dry key produced a failed email_drafts
  // row per lead at ~2.3s each, and three of those permanently capped the
  // lead: 20 of the 100 leads in ANKIT's APOLLO CAMPAIGN 1 were written off on
  // 7 Aug 2026 for an empty billing account that had nothing to do with them.
  //
  // Returning BEFORE fetchDraftTargets is the point. Bailing out later would
  // still have to decide what to do with leads already claimed; bailing here
  // means no lead is touched at all, so nothing needs forgiving afterwards.
  // Opening emails wait for the MAIN model (canDraftOpenings); a healthy
  // backup alone does not start them. Follow-ups keep the any-key rule.
  const campaignRef = { id: campaign.id as string, name: campaign.name as string, company_id: campaign.company_id as string };
  const canDraft = stepNumber === 1
    ? await canDraftOpenings(cdb, campaignRef)
    : await hasUsableLlmKey(db, campaign.company_id as string);
  if (!canDraft) {
    // A [TEST] campaign's "no credits" is a scenario, not an outage to report.
    if (isMockCampaign(campaignRef.company_id, campaignRef.name)) {
      return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "llm_unavailable" });
    }
    // Feeds the red service-health banner. reset_stuck_draft_generation above
    // has already released the campaign from 'processing', so the UI shows a
    // stopped campaign plus a banner saying why, instead of a silent stall.
    await logLlmUnavailable(
      cdb,
      null,
      "Every configured LLM key is out of credits or rejected — draft generation was not started.",
      { campaign_id: campaignId, step: stepNumber },
    );
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "llm_unavailable" });
  }

  // Only STEP-1 runs drive the campaign's status (draft ↔ processing). A
  // follow-up (step > 1) run happens on an already-ACTIVE campaign — flipping
  // its status here dragged live campaigns back to "Draft" in the UI
  // (planning.md Phase 6.4).
  const drivesStatus = stepNumber === 1;

  const targets = await fetchDraftTargets(cdb, campaignId, DRAFT_CONCURRENCY * 4, stepNumber);

  if (targets.length === 0) {
    const pending = await countPendingDrafts(cdb, campaignId);
    if (pending === 0 && drivesStatus && campaign.status === "processing") {
      await cdb.from("campaigns").update({
        status: "draft",
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);
    }
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "no_more_pending" });
  }

  if (drivesStatus && ["draft", "processing"].includes(campaign.status)) {
    await cdb.from("campaigns").update({
      status: "processing",
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
  }

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();
  let ranOutOfTime = false;
  let llmOutage = false;

  const budget = new BatchBudget();
  for (let i = 0; i < targets.length && !llmOutage; i += DRAFT_CONCURRENCY) {
    // Measured, not assumed: stop when there is no room for another call as
    // slow as the slowest one this invocation has already seen. A flat 40s
    // budget was tuned to the 6.2s average and stranded drafts on the 10.5s
    // ones — see lib/services/batch-budget.ts. A group takes as long as its
    // slowest call, which is exactly what the budget measures.
    if (!budget.hasRoomForAnother()) { ranOutOfTime = true; break; }
    const results = await Promise.all(targets.slice(i, i + DRAFT_CONCURRENCY).map((target) => budget.run(() => generateOneDraft(
      cdb,
      target,
      campaignId,
      campaign.company_id as string,
      campaign.human_in_loop,
      campaign.name,
      undefined,
      undefined,
      campaign.ai_prompt_context ?? undefined,
      undefined,
      stepNumber,
    ))));
    for (const result of results) {
      if (result.ok) { succeeded++; continue; }
      // Another worker got there first — the lead has its draft, so this is not a
      // failure and must not be counted as one. The self-chain overlapping the
      // 10-minute watchdog makes this an ordinary event, not an edge case.
      if (result.skipped) { skipped++; continue; }
      failed++;

      // The pre-flight above runs once per batch, so a key that dies on the
      // FIRST lead still leaves nine more to be attempted against a provider we
      // now know is refusing everyone. Those failures are forgiven
      // (rejection_reason carries PROVIDER_UNAVAILABLE, so they don't count
      // toward any lead's retry cap) but they are pointless work that writes
      // rows a human has to read past. Stop the batch
      // (the rest of this group is already in flight; no new group starts).
      //
      // And do NOT self-chain afterwards. Re-entering would rely on the
      // pre-flight to break the cycle, which it cannot promise: it answers "is a
      // key usable?" from provider_keys, so a stale-healthy row or an env-var key
      // that is itself dry passes the check and fails the call, and the route
      // would chain into itself forever. Ending the run is the safe stop — the
      // watchdog re-kicks this campaign within 10 minutes once a key works again.
      if (isProviderOutage(result.reason)) llmOutage = true;
    }
  }

  const remaining = await countPendingDrafts(cdb, campaignId);

  if (llmOutage) {
    // Leave the campaign released (reset_stuck_draft_generation already put it
    // back to 'draft') and stop. Leads keep their retries; the banner is up;
    // the watchdog owns resuming this.
    return Response.json({
      processed: succeeded + failed + skipped, succeeded, failed, skipped, remaining, status: "llm_unavailable",
    });
  }

  // Same reason as the follow-up writer: a success row is what clears the
  // "no LLM credits" banner, and only org scraping used to write one.
  if (succeeded > 0) await logLlmRecovered(cdb, campaign.company_id as string);

  if (remaining > 0 || ranOutOfTime) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET!;
    // after() keeps the lambda alive until the next batch kickoff actually leaves
    // the machine, so generation doesn't silently stop mid-campaign. (§1.2)
    after(async () => {
      await fetch(`${baseUrl}/api/enrich/generate-drafts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({ campaign_id: campaignId, step_number: stepNumber }),
      }).catch(() => {});
    });
  } else if (drivesStatus && ["draft", "processing"].includes(campaign.status)) {
    // Only a campaign that was still pre-send drops back to 'draft' when the
    // queue empties. A LIVE campaign must not: drafting one late-added lead
    // (a bounce replacement, a lead added to a running campaign) would
    // otherwise drag the whole campaign back to Draft in the UI while
    // Instantly is mid-sequence. Matches the same guard on the
    // no-targets branch above.
    await cdb.from("campaigns").update({
      status: "draft",
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
  }

  return Response.json({
    processed: succeeded + failed + skipped,
    skipped,
    succeeded,
    failed,
    remaining,
  });
}

/** Restart opening-draft generation on any campaign whose chain has died. */
async function pumpStalledCampaigns(req: NextRequest, db: ReturnType<typeof createAdminClient>) {
  // Same candidates as the watchdog: drafts were asked for, and the campaign is
  // not paused or finished — those must not start spending AI credits.
  const { data: candidates } = await db
    .from("campaigns")
    .select("id, name, company_id")
    .in("status", ["draft", "processing", "active"])
    .eq("is_deleted", false)
    .not("draft_generation_started_at", "is", null);

  // One read narrows ~20 campaigns to the few with any lead still waiting, so
  // an idle pass is two queries instead of four per campaign (measured 23s).
  const { data: waiting } = await db
    .from("campaign_leads")
    .select("campaign_id, leads!lead_id!inner(email)")
    .in("campaign_id", (candidates ?? []).map((c) => c.id as string))
    .is("draft_id", null)
    .in("crm_status", ["new", "enriched", "draft"])
    .not("leads.email", "is", null);
  const hasWaiting = new Set((waiting ?? []).map((w) => w.campaign_id as string));

  const kicked: string[] = [];
  for (const c of (candidates ?? []).filter((c) => hasWaiting.has(c.id as string))) {
    if (kicked.length >= 3) break;
    if (!(await isDraftGenerationStalled(db, c.id as string))) continue;
    // A dead key is the watchdog's to report (once per pass); kicking here
    // would write an outage row every minute.
    if (!(await canDraftOpenings(db, { id: c.id as string, name: c.name as string, company_id: c.company_id as string }))) continue;
    kicked.push(c.id as string);
  }

  if (kicked.length > 0) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET!;
    after(async () => {
      await Promise.all(kicked.map((id) => fetch(`${baseUrl}/api/enrich/generate-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ campaign_id: id }),
      }).catch(() => {})));
    });
  }
  return Response.json({ status: kicked.length ? "kicked" : "idle", kicked });
}
