import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertThreadAccessById } from "@/lib/auth/scope";
import { setLeadInterestStatus } from "@/lib/services/unibox";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { threadId } = await params;
  try { await assertThreadAccessById(dbForUser(user), user, threadId); } catch (r) { return r as Response; }
  const body = await req.json().catch(() => null) as { interest_value?: number | null; lead_email?: string } | null;
  if (!body || !("interest_value" in body)) {
    return fail(400, "VALIDATION_ERROR", "interest_value required");
  }

  const db = dbForUser(user);

  // Resolve the campaign_lead tied to THIS thread specifically — a lead can be
  // enrolled in multiple campaigns, and the status change must only apply to the
  // one the user is actually looking at, not every campaign that email is in.
  const { data: threadRow } = await db
    .from("unibox_emails")
    .select("lead_email, campaign_lead_id")
    .eq("thread_id", threadId)
    .not("campaign_lead_id", "is", null)
    .limit(1)
    .maybeSingle();

  const leadEmail = body.lead_email ?? threadRow?.lead_email ?? null;
  if (!leadEmail) return fail(400, "MISSING_LEAD", "Could not resolve lead email for thread");

  await setLeadInterestStatus(db, {
    leadEmail,
    interestValue: body.interest_value ?? null,
    actorId: user.id,
    campaignLeadId: threadRow?.campaign_lead_id ?? null,
  });

  return ok({ lead_email: leadEmail, interest_value: body.interest_value });
}
