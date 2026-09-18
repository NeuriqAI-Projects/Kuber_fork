import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { FollowUpRegenerateSchema } from "@/lib/validators/drafts";
import { regenerateFollowUpText } from "@/lib/services/followup-regenerate";
import { resolveFollowupTemplate, AI_OFF_REASON } from "@/lib/services/followup-template";
import { renderFollowupFallback } from "@/lib/services/settings";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";

// Deliberately separate from /drafts/[id]/regenerate (the step-1 draft's
// regenerate endpoint) and from generateOneDraft entirely. Follow-up
// regeneration only ever sees the current follow-up text + the user's
// instruction — no lead/org context, no product library, no shared prompt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = FollowUpRegenerateSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: cl } = await db
    .from("campaign_leads")
    .select("id, lead_id, campaign_id, leads!lead_id(first_name, last_name, organizations(name))")
    .eq("id", parsed.data.campaign_lead_id)
    .eq("campaign_id", id)
    .maybeSingle();

  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");

  const leadRow = (Array.isArray(cl.leads) ? cl.leads[0] : cl.leads) as Record<string, unknown> | null;

  // With AI follow-ups switched off, Rewrite means "put this step's text back",
  // not "ask the model" — otherwise the button quietly spends credits on a
  // campaign the client deliberately took off AI.
  const { data: campaign } = await db
    .from("campaigns").select("followups_ai_enabled").eq("id", id).maybeSingle();
  const aiOff = campaign?.followups_ai_enabled === false;

  let rewritten: { body: string };
  if (aiOff) {
    const org = leadRow?.organizations as { name?: string | null } | { name?: string | null }[] | null | undefined;
    rewritten = {
      body: renderFollowupFallback(
        await resolveFollowupTemplate(db, id, parsed.data.step_number),
        (leadRow?.first_name as string | null) ?? "",
        (Array.isArray(org) ? org[0] : org)?.name,
        leadRow?.last_name as string | null,
      ),
    };
  } else {
    try {
      rewritten = await regenerateFollowUpText({
        leadFirstName: (leadRow?.first_name as string | null) ?? null,
        currentBody: parsed.data.body,
        instruction: parsed.data.instruction ?? "Rewrite this follow-up.",
        companyId: user.companyId ?? "any",
      });
    } catch (e) {
      return fail(502, "GENERATION_FAILED", (e as Error).message);
    }
  }

  const { data: existing } = await db
    .from("email_drafts")
    .select("id, version")
    .eq("campaign_id", id)
    .eq("lead_id", cl.lead_id)
    .eq("step_number", parsed.data.step_number)
    .not("status", "in", "(rejected,failed)")
    .maybeSingle();

  const now = new Date().toISOString();
  const eventMeta = { campaign_id: id, step: parsed.data.step_number };

  if (existing) {
    await db.from("email_drafts").update({
      status: "rejected",
      rejection_reason: "superseded by follow-up regeneration",
      updated_at: now,
    }).eq("id", existing.id);
    // This route never logged anything before — a regenerated follow-up
    // silently replaced the old draft with no trace on the activity timeline.
    await logLeadEvent(db, cl.lead_id, "draft_rejected", `Follow-up email draft superseded by regeneration (step ${parsed.data.step_number})`, {
      actorId: user.id, metadata: { ...eventMeta, draft_id: existing.id },
    });
  }

  const { data: draft, error } = await db
    .from("email_drafts")
    .insert({
      lead_id: cl.lead_id,
      campaign_id: id,
      step_number: parsed.data.step_number,
      subject: "", // follow-ups always thread as a reply
      body: rewritten.body,
      status: "draft",
      // Labelled for what it is, so the Sequences quality count stays honest:
      // this one was not written by the AI.
      ...(aiOff ? { source: "template", fallback_reason: AI_OFF_REASON } : {}),
      version: (existing?.version ?? 0) + 1,
      parent_draft_id: existing?.id ?? null,
      created_at: now,
    })
    .select("id, subject, body, status")
    .single();

  if (error || !draft) return fail(500, "INTERNAL", error?.message ?? "Failed to save regenerated draft");

  await logLeadEvent(db, cl.lead_id, "draft_created", `Follow-up email regenerated (step ${parsed.data.step_number})`, {
    actorId: user.id, metadata: { ...eventMeta, draft_id: draft.id },
  });

  return ok({ draft });
}
