import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { AI_UNAVAILABLE, countPendingDrafts, fetchDraftTargets, generateOneDraft } from "@/lib/services/generate-drafts";

export const maxDuration = 55;

/**
 * Give every lead still waiting for an opening email the default email now.
 *
 * For when the AI is out of credits and the campaign cannot wait: chosen at
 * creation ("Use the default email for everyone") or from the "Drafting paused"
 * bar. No AI is called. Each lead is marked AI_UNAVAILABLE so it shows as a
 * default email and needs certifying like any other draft.
 *
 * Works through as many leads as fit in one request and reports what is left;
 * the caller repeats until `remaining` is 0. The default email is only database
 * work (~1s a lead), so a few calls cover a large campaign.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, company_id, human_in_loop, ai_prompt_context")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  const startedAt = Date.now();
  let written = 0;
  while (Date.now() - startedAt < 40_000) {
    const targets = await fetchDraftTargets(db, id, 16, 1);
    if (targets.length === 0) break;
    const results = await Promise.all(targets.map((t) => generateOneDraft(
      db, t, id, campaign.company_id as string, campaign.human_in_loop as boolean, campaign.name as string,
      user.id, undefined, (campaign.ai_prompt_context as string | null) ?? undefined, undefined, 1,
      undefined, null, null, `${AI_UNAVAILABLE}: AI was out of credits; the default email was chosen instead.`,
    )));
    written += results.filter((r) => r.ok).length;
    // Nothing succeeded in a whole round: stop rather than spin on the same leads.
    if (!results.some((r) => r.ok)) break;
  }

  return ok({ written, remaining: await countPendingDrafts(db, id) });
}
