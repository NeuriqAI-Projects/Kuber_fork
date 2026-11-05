import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { BulkApproveSchema } from "@/lib/validators/drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { logLeadEvents } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";
import { getActiveJob } from "@/lib/services/regeneration-jobs";

/** Ids per `.in()` (they travel in the URL). */
function chunks(ids: string[], size = 100): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = BulkApproveSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const now = new Date().toISOString();

  let approved = 0;
  let skipped = 0;

  // Same rule as the single-draft approve: nothing may be certified while a bulk
  // regeneration is live for that campaign+step, because the run is about to
  // rewrite these very drafts. Memoised — a bulk approve is usually one campaign,
  // and this must not become one job lookup per draft.
  const activeJobByKey = new Map<string, boolean>();
  async function regenerationRunning(campaignId: string, stepNumber: number) {
    const key = `${campaignId}:${stepNumber}`;
    const cached = activeJobByKey.get(key);
    if (cached !== undefined) return cached;
    const running = !!(await getActiveJob(db, campaignId, stepNumber));
    activeJobByKey.set(key, running);
    return running;
  }

  // Set-based (was ~7 trips per draft, one draft at a time): one read, the same
  // per-campaign checks, then each write once for all eligible drafts.
  const uniqueIds = [...new Set(parsed.data.draft_ids)];
  skipped += parsed.data.draft_ids.length - uniqueIds.length; // a repeat id found its draft already approved
  type Draft = { id: string; status: string; lead_id: string; campaign_id: string; step_number: number | null };
  const drafts: Draft[] = [];
  for (const ids of chunks(uniqueIds)) {
    const { data } = await db.from("email_drafts").select("id, status, lead_id, campaign_id, step_number").in("id", ids);
    drafts.push(...((data ?? []) as Draft[]));
  }
  const byId = new Map(drafts.map((d) => [d.id, d]));

  const accessByCampaign = new Map<string, boolean>();
  const eligible: Draft[] = [];
  for (const draftId of uniqueIds) {
    const draft = byId.get(draftId);
    if (!draft || draft.status !== "draft") { skipped++; continue; }
    if (!accessByCampaign.has(draft.campaign_id)) {
      accessByCampaign.set(draft.campaign_id, await assertCampaignAccess(db, user, draft.campaign_id).then(() => true, () => false));
    }
    if (!accessByCampaign.get(draft.campaign_id)) { skipped++; continue; }
    if (await regenerationRunning(draft.campaign_id, draft.step_number ?? 1)) { skipped++; continue; }
    eligible.push(draft);
  }

  for (const ids of chunks(eligible.map((d) => d.id))) {
    await db.from("email_drafts").update({
      status: "approved",
      approved_at: now,
      reviewed_by: user.id,
      updated_at: now,
    }).in("id", ids);

    // Never downgrade a lead already handed to Instantly — see the same guard in
    // drafts/[id] approve. A regeneration finishing after the send would otherwise
    // rewind 'sent' to 'approved' on a lead that has genuinely been mailed.
    await db.from("campaign_leads").update({
      crm_status: "approved",
      updated_at: now,
    }).in("draft_id", ids).is("instantly_campaign_id", null);
  }

  // Once per lead+campaign, after every draft is approved: the sync pushes all
  // approved steps, so this ends where the old per-draft syncs ended. It is a
  // no-op for leads not yet in Instantly (the usual case).
  const key = (d: { lead_id: string; campaign_id: string }) => `${d.lead_id}:${d.campaign_id}`;
  const inInstantly = new Set<string>();
  for (const ids of chunks([...new Set(eligible.map((d) => d.lead_id))])) {
    const { data } = await db.from("campaign_leads").select("lead_id, campaign_id").in("lead_id", ids).not("instantly_lead_id", "is", null);
    for (const r of data ?? []) inInstantly.add(key(r as { lead_id: string; campaign_id: string }));
  }
  const pairs = [...new Map(eligible.map((d) => [key(d), d])).values()].filter((d) => inInstantly.has(key(d)));
  for (const d of pairs) await syncApprovedDraftToInstantly(db, d.lead_id, d.campaign_id);

  await logLeadEvents(db, eligible.map((d) => ({
    leadId: d.lead_id, event: "draft_approved" as const, detail: "Email draft approved", actorId: user.id,
    metadata: { campaign_id: d.campaign_id, draft_id: d.id, bulk: true },
  })));
  approved = eligible.length;

  return ok({ approved, skipped });
}
