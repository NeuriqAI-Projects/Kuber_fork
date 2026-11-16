import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { ok, fail } from "@/lib/api-response";
import { resumeCampaign } from "@/lib/services/campaign-lifecycle";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

/** Resume a paused campaign — re-activates its Instantly sub-campaigns. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:send"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  // Every lead's sending (resume also releases a hold someone else placed): shared-campaign rule.
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  try {
    const result = await resumeCampaign(db, id);
    return ok(result);
  } catch (err) {
    return fail(502, "INSTANTLY_ERROR", (err as Error).message);
  }
}
