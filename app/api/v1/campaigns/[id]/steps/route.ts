import { NextRequest, after } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CampaignStepsSchema } from "@/lib/validators/campaigns";
import { countMissingText, publishSequenceNow } from "@/lib/services/sequence-publish";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { assertCampaignAccess, assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { pickFollowupTemplate } from "@/lib/services/followup-template";
import { getFollowupFallbackTemplate } from "@/lib/services/settings";
import { refreshTemplateFollowups, type RefreshResult } from "@/lib/services/followup-refresh";

// Saving can rewrite already-written follow-ups and push each to Instantly.
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }
  const { data } = await db
    .from("campaign_steps")
    .select("id,step_order,delay,delay_unit,subject,body,ai_instruction,fallback_body")
    .eq("campaign_id", id)
    .order("step_order");

  const { data: campaign } = await db
    .from("campaigns").select("followup_instruction, followups_ai_enabled").eq("id", id).maybeSingle();

  return ok({
    steps: data ?? [],
    followup_instruction: (campaign?.followup_instruction as string | null) ?? null,
    followups_ai_enabled: (campaign?.followups_ai_enabled as boolean | null) ?? true,
  });
}

// Sequence steps are campaign-wide templates that propagate live to every
// Instantly sub-campaign already sending, i.e. to every lead in this container
// (spec §5, docs/notes/EDGE_CASES.md §2.10). So: managers always, and an employee only on a
// campaign no other employee is part of, where the only leads they can affect
// are their own. GET above stays open to any employee with campaign access so
// they can still view the sequence content read-only.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const parsed = CampaignStepsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // flatten() folds every nested problem under "steps" with no index or field,
    // so the toast said only "steps — Invalid input" and nobody could tell which
    // step or field was rejected. Name them.
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(400, "VALIDATION_ERROR", `Invalid steps (${where})`, parsed.error.flatten());
  }

  const db = dbForUser(user);
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  // Campaign-wide follow-up guidance. Optional: a caller that omits it (the
  // Options tab, which has no such box) must not blank what someone typed in
  // the Sequences tab.
  if (parsed.data.followup_instruction !== undefined || parsed.data.followups_ai_enabled !== undefined) {
    await db.from("campaigns")
      .update({
        ...(parsed.data.followup_instruction !== undefined ? { followup_instruction: parsed.data.followup_instruction || null } : {}),
        ...(parsed.data.followups_ai_enabled !== undefined ? { followups_ai_enabled: parsed.data.followups_ai_enabled } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  }

  // What each step fell back to BEFORE this save, so we can tell which
  // steps' default text actually changed.
  const { data: oldSteps } = await db.from("campaign_steps").select("step_order, fallback_body").eq("campaign_id", id);

  // Replace all steps for this campaign
  await db.from("campaign_steps").delete().eq("campaign_id", id);
  const { error } = await db.from("campaign_steps").insert(
    parsed.data.steps.map((s) => ({
      ...s,
      campaign_id: id,
      created_at: new Date().toISOString(),
    })),
  );
  if (error) return fail(500, "INTERNAL", error.message);

  // A step's default text changed: rewrite the unsent follow-ups written from
  // the old text (lib/services/followup-refresh.ts). Sent, AI-written and
  // hand-edited ones are left alone.
  const settingsDefault = await getFollowupFallbackTemplate(db);
  const oldByStep = new Map((oldSteps ?? []).map((s) => [s.step_order as number, s.fallback_body as string | null]));
  const refreshed: RefreshResult[] = [];
  for (const s of parsed.data.steps) {
    if (s.step_order < 2 || !oldByStep.has(s.step_order)) continue;
    const oldText = pickFollowupTemplate(oldByStep.get(s.step_order), settingsDefault);
    const newText = pickFollowupTemplate(s.fallback_body, settingsDefault);
    if (oldText !== newText) refreshed.push(await refreshTemplateFollowups(db, id, s.step_order, newText));
  }

  // PREPARE, THEN PUBLISH.
  //
  // Instantly acts on a schedule change within seconds; writing the personalised
  // follow-ups it makes due takes about an hour for a few hundred leads. Patching
  // here — which is what this route used to do — meant Instantly found a pile of
  // newly overdue steps and sent its generic fallback to every one of them before
  // a single real email existed. The user got the timing they asked for and the
  // emails they did not.
  //
  // So the change is saved locally, Instantly is left on the OLD schedule (it
  // keeps doing exactly what it was doing, which is the safe place to be), and
  // the publish happens after the text lands. Late is recoverable; boilerplate to
  // three hundred customers is not.
  const missing = await countMissingText(db, id);

  if (missing === 0) {
    // Nothing this change makes due is unwritten, so there is no race to lose:
    // publish immediately and keep the old instant-feedback behaviour.
    await publishSequenceNow(db, id);
    return ok({ updated: true, published: true, preparing: 0, refreshed });
  }

  await db.from("campaigns").update({
    sequence_publish_pending: true,
    sequence_publish_requested_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  // Start writing now rather than waiting for the next scheduled sweep — the
  // user is standing there having just asked for this.
  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/internal/write-followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ limit: 25 }),
      }).catch(() => {}),
    );
  }

  return ok({ updated: true, published: false, preparing: missing, refreshed });
}
