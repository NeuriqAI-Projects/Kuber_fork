import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { ok, fail } from "@/lib/api-response";
import { holdSending } from "@/lib/services/campaign-lifecycle";
import { dbForUser } from "@/lib/supabase/scoped";

// 31 sub-campaigns is the largest live campaign; each pause is one Instantly
// call at ~300ms, so a worst case is around 10s. Comfortably inside 60.
export const maxDuration = 60;

/**
 * Hold sending on this campaign — stops Instantly sending anything further,
 * including queued follow-ups, until someone resumes it.
 *
 * Anyone with campaigns:send and access to the campaign may hold — even on a
 * campaign shared with teammates (no shared-campaign rule here): when a wrong
 * email is going out, speed matters more than permission, and the hold is recorded against the user
 * so an open hold always has a name on it. Releasing goes through the existing
 * /resume route, which clears the same stamp.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:send"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  try {
    const result = await holdSending(db, id, user.id);
    return ok(result);
  } catch (err) {
    return fail(502, "INSTANTLY_ERROR", (err as Error).message);
  }
}
