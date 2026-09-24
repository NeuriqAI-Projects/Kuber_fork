import { NextRequest, after } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { isDraftGenerationStalled } from "@/lib/services/generate-drafts";

/**
 * Restart opening-draft generation whose batch chain has died.
 *
 * The drawer calls this about once a minute while leads are still waiting for
 * a draft. It only starts a worker when generation has genuinely stopped (see
 * isDraftGenerationStalled), so pressing it on a live run does nothing — and a
 * second worker could not duplicate a draft anyway (unique index).
 *
 * Unlike POST generate-drafts it never touches the campaign's status, so it is
 * safe on a campaign that is already sending: leads left without a draft when
 * someone pressed Send all still get written, and wait to be certified.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  // Only campaigns someone asked drafts for, and never a paused or finished
  // one — opening its drawer must not start spending AI credits.
  const { data: campaign } = await db
    .from("campaigns")
    .select("status, draft_generation_started_at")
    .eq("id", id)
    .eq("is_deleted", false)
    .maybeSingle();
  if (!campaign?.draft_generation_started_at || !["draft", "processing", "active"].includes(campaign.status as string)) {
    return ok({ kicked: false });
  }

  const secret = process.env.INTERNAL_SECRET;
  if (!secret || !(await isDraftGenerationStalled(db, id))) return ok({ kicked: false });

  const baseUrl = internalAppBaseUrl(req);
  after(async () => {
    await fetch(`${baseUrl}/api/enrich/generate-drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ campaign_id: id }),
    }).catch(() => {});
  });
  return ok({ kicked: true });
}
