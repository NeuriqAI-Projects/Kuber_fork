import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { getLatestJob } from "@/lib/services/regeneration-jobs";
import { dbForUser } from "@/lib/supabase/scoped";

/**
 * The campaign's live regeneration job, or the most recent finished one.
 * Polled by the drawer while a run is in flight; also lets a user who reopens
 * the campaign later see how the last run ended.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const url = new URL(req.url);
  const stepNumber = Number(url.searchParams.get("step_number") ?? 1) || 1;

  const job = await getLatestJob(db, id, stepNumber);
  if (!job) return ok({ job: null });

  const processed = job.succeeded + job.failed;
  // A finished run may have released the hold it needed (resumeIfHeldForJob).
  // The drawer polls this, so it is where the banner learns that.
  const { data: c } = await db.from("campaigns").select("sending_held_at").eq("id", id).maybeSingle();
  return ok({
    job: {
      ...job,
      processed,
      active: job.status === "queued" || job.status === "running",
      sending_held: !!c?.sending_held_at,
    },
  });
}
