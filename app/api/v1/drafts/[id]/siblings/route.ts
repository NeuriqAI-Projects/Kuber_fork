import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertDraftAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Other sequence steps (e.g. the already-sent step 1) for the same lead in
// this campaign — shown as read-only context next to a follow-up draft, not
// mixed into that draft's own version history (see /history).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertDraftAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: draft } = await db
    .from("email_drafts")
    .select("id, lead_id, campaign_id, step_number")
    .eq("id", id)
    .maybeSingle();

  if (!draft) return fail(404, "NOT_FOUND", "Draft not found");

  const { data: siblings, error } = await db
    .from("email_drafts")
    .select("id, step_number, subject, body, status, created_at")
    .eq("campaign_id", draft.campaign_id)
    .eq("lead_id", draft.lead_id)
    .neq("step_number", draft.step_number)
    .not("status", "in", "(rejected,failed)")
    .order("step_number", { ascending: true });

  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ siblings: siblings ?? [] });
}
