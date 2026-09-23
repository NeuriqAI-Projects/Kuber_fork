import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { FollowUpSaveSchema } from "@/lib/validators/drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";
import { patchInstantlySequences, type InstantlyStep } from "@/lib/services/instantly";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";

// Save for a follow-up: persist + approve + sync to Instantly in one atomic
// action, entirely separate from /drafts/[id] PATCH (whose "edit" action
// requires a non-empty subject — follow-ups are always empty so they thread
// as a reply, which made that shared action silently 400 on every follow-up
// save). Creates the draft row if none exists yet (a manual write), or
// updates the existing one in place otherwise — never bumps a new version,
// since this is editing the same email, not asking the AI to rewrite it.
//
// Deliberately never calls the LLM (see complete() in lib/services/llm.ts) —
// a manual save costs nothing and must not write an llm_usage row, since the
// campaign Cost table (app/api/v1/campaigns/[id]/llm-cost) sums exactly that
// table and would otherwise bill a human-written edit as if the AI wrote it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = FollowUpSaveSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: cl } = await db
    .from("campaign_leads")
    .select("id, lead_id, campaign_id")
    .eq("id", parsed.data.campaign_lead_id)
    .eq("campaign_id", id)
    .maybeSingle();

  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");

  const now = new Date().toISOString();

  const { data: existing } = await db
    .from("email_drafts")
    .select("id")
    .eq("campaign_id", id)
    .eq("lead_id", cl.lead_id)
    .eq("step_number", parsed.data.step_number)
    .not("status", "in", "(rejected,failed)")
    .maybeSingle();

  let draftId: string;
  const eventMeta = { campaign_id: id, step: parsed.data.step_number };

  if (existing) {
    const { error } = await db.from("email_drafts").update({
      subject: parsed.data.subject,
      body: parsed.data.body,
      status: "approved",
      // A human is editing this lead's copy directly — mark it protected so a
      // campaign-wide "Rewrite follow-up N for N leads" run leaves it alone.
      source: "manual",
      approved_at: now,
      updated_at: now,
    }).eq("id", existing.id);
    if (error) return fail(500, "INTERNAL", error.message);
    draftId = existing.id;
    // This endpoint is a single atomic "write + approve" action (see the
    // file comment above) — it never had ANY lead_events logging before,
    // so follow-up saves were entirely invisible on the activity timeline.
    await logLeadEvent(db, cl.lead_id, "draft_edited", `Follow-up email edited (step ${parsed.data.step_number})`, {
      actorId: user.id, metadata: { ...eventMeta, draft_id: draftId },
    });
  } else {
    const { data: draft, error } = await db
      .from("email_drafts")
      .insert({
        lead_id: cl.lead_id,
        campaign_id: id,
        step_number: parsed.data.step_number,
        subject: parsed.data.subject,
        body: parsed.data.body,
        status: "approved",
        // Same reasoning as the update branch above: a manual write is a
        // human-authored override for this one lead.
        source: "manual",
        approved_at: now,
        created_at: now,
      })
      .select("id")
      .single();
    if (error || !draft) return fail(500, "INTERNAL", error?.message ?? "Failed to save draft");
    draftId = draft.id;
    await logLeadEvent(db, cl.lead_id, "draft_created", `Follow-up email draft written (step ${parsed.data.step_number})`, {
      actorId: user.id, metadata: { ...eventMeta, draft_id: draftId },
    });
  }

  // Both branches above always end with status "approved" — this endpoint
  // has no separate draft/review stage, unlike the AI-generated flow.
  await logLeadEvent(db, cl.lead_id, "draft_approved", `Follow-up email approved (step ${parsed.data.step_number})`, {
    actorId: user.id, metadata: { ...eventMeta, draft_id: draftId },
  });

  const instantlySync = await syncApprovedDraftToInstantly(db, cl.lead_id, id);

  // If the sequence step template in Instantly still has the old hardcoded body
  // (not the {{customBodyN}} variable placeholder), patch it now so future sends
  // actually use the per-lead variable. This covers campaigns created before the
  // {{customBodyN}} template was introduced.
  const expectedTemplate = `{{customBody${parsed.data.step_number}}}`;
  const { data: stepRow } = await db
    .from("campaign_steps")
    .select("body")
    .eq("campaign_id", id)
    .eq("step_order", parsed.data.step_number)
    .maybeSingle();

  if (stepRow && stepRow.body !== expectedTemplate) {
    // Update our DB first
    await db
      .from("campaign_steps")
      .update({ body: expectedTemplate, updated_at: now })
      .eq("campaign_id", id)
      .eq("step_order", parsed.data.step_number);

    // Re-fetch all steps and patch every Instantly sub-campaign
    const { data: allSteps } = await db
      .from("campaign_steps")
      .select("step_order, subject, body, delay, delay_unit")
      .eq("campaign_id", id)
      .order("step_order");

    const steps: InstantlyStep[] = (allSteps ?? []).map((s) => ({
      subject: s.subject ?? "",
      body: s.step_order === parsed.data.step_number ? expectedTemplate : (s.body ?? ""),
      delay: s.delay ?? 0,
      delayUnit: (s.delay_unit ?? "days") as InstantlyStep["delayUnit"],
    }));

    const { data: subs } = await db
      .from("instantly_campaigns")
      .select("instantly_campaign_id")
      .eq("campaign_id", id)
      .not("instantly_campaign_id", "is", null);

    for (const sub of subs ?? []) {
      if (sub.instantly_campaign_id) {
        await patchInstantlySequences(sub.instantly_campaign_id, steps).catch((e) => {
          console.error("followup-save: patchInstantlySequences failed:", e);
        });
      }
    }
  }

  const { data: finalDraft } = await db
    .from("email_drafts")
    .select("id, subject, body, status")
    .eq("id", draftId)
    .single();

  return ok({ draft: finalDraft, instantly_sync: instantlySync });
}
