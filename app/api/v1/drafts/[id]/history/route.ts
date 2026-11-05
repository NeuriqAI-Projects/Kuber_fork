import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertDraftAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

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

  // Scoped to the SAME step only — a follow-up (step 2) is a different email
  // from the initial send (step 1), not a "version" of it. Mixing steps here
  // would let a user "restore" an already-sent step over a follow-up draft.
  const { data: versions, error } = await db
    .from("email_drafts")
    .select("id, subject, body, status, version, parent_draft_id, created_at")
    .eq("campaign_id", draft.campaign_id)
    .eq("lead_id", draft.lead_id)
    .eq("step_number", draft.step_number)
    .order("version", { ascending: true });

  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ versions: versions ?? [] });
}
