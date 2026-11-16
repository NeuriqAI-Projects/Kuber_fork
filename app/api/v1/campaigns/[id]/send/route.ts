import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { ok, fail } from "@/lib/api-response";
import { sendCampaign } from "@/lib/services/campaign-fanout";
import { SendCampaignSchema } from "@/lib/validators/campaigns";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

// No override before: this route ran on whatever the platform's default
// timeout happened to be, with zero declared margin. Instantly's bulk-add
// tops out at 100 req/s and 6000/min (shared workspace-wide), so the real
// worst case here isn't lead volume — it's a slow country-bucket loop (each
// bucket needs a campaign create/patch call, its lead batches, then its own
// activation call) plus this app's own 2s inter-batch spacing. 120s matches
// the other multi-step Instantly/DB routes in this app (bulk-delete) and
// leaves comfortable headroom over the worst realistic 1000-lead case.
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:send"); } catch (r) { return r as Response; }
  const { id } = await params;
  try { await assertCampaignAccess(dbForUser(user), user, id); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => ({}));
  const parsed = SendCampaignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  try {
    const result = await sendCampaign(id, user.id, {
      campaignLeadIds: parsed.data.campaign_lead_ids,
      // A shared campaign can hold leads from several lead owners (spec §5);
      // a member without campaigns:all triggering Send must only ever push their
      // own, never a co-worker's, even though assertCampaignAccess above already
      // let them into this campaign. Members with campaigns:all send the whole campaign.
      restrictToLeadOwnerId: canSeeAll(user.member, "campaigns") ? null : user.id,
    });
    return ok(result);
  } catch (err) {
    return fail(500, "INSTANTLY_ERROR", (err as Error).message);
  }
}
