import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { getActiveJob } from "@/lib/services/regeneration-jobs";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

/**
 * Cancel the campaign's running regeneration.
 *
 * This is cooperative, not a kill: the worker re-reads the job status before
 * each batch and stops there. Drafts already regenerated keep their new version
 * (they are finished work, not partial), and untouched leads keep the draft they
 * have — nothing is rolled back.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:generate"); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  // Stops a campaign-wide job someone else may have started: shared-campaign rule.
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => ({})) as { step_number?: number };
  const stepNumber = body.step_number ?? 1;

  const job = await getActiveJob(db, id, stepNumber);
  if (!job) return fail(404, "NOT_FOUND", "No regeneration is running for this campaign.");

  const now = new Date().toISOString();
  await db.from("draft_regeneration_jobs").update({
    status: "cancelled",
    finished_at: now,
  }).eq("id", job.id);

  // A draft mid-flight in the current batch is left alone — regenerateOneDraft
  // finishes or reverts it on its own. Only untouched work is dropped.
  const { count } = await db
    .from("draft_regeneration_job_items")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .eq("status", "pending");

  return ok({ job_id: job.id, cancelled: true, remaining: count ?? 0 });
}
