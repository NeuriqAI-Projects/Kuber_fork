import type { createAdminClient } from "@/lib/supabase/admin";
import { pauseInstantlyCampaign, activateInstantlyCampaign, deleteInstantlyCampaign } from "@/lib/services/instantly";

type Db = ReturnType<typeof createAdminClient>;

async function subCampaigns(db: Db, campaignId: string) {
  const { data } = await db
    .from("instantly_campaigns")
    .select("id, instantly_campaign_id")
    .eq("campaign_id", campaignId)
    .not("instantly_campaign_id", "is", null);
  return (data ?? []).filter((s) => s.instantly_campaign_id) as Array<{ id: string; instantly_campaign_id: string }>;
}

/**
 * Pause every Instantly sub-campaign of a master, then mark the master paused.
 * THIS is the only way to actually stop Instantly from sending (incl. follow-ups).
 * Best-effort per sub — collects errors rather than aborting on the first.
 */
export async function pauseCampaign(db: Db, campaignId: string): Promise<{ paused: number; errors: string[] }> {
  const subs = await subCampaigns(db, campaignId);
  const errors: string[] = [];
  let paused = 0;
  const now = new Date().toISOString();
  for (const sub of subs) {
    try {
      await pauseInstantlyCampaign(sub.instantly_campaign_id);
      await db.from("instantly_campaigns").update({ status: "paused", updated_at: now }).eq("id", sub.id);
      paused++;
    } catch (e) {
      errors.push(`sub ${sub.id}: ${(e as Error).message}`);
    }
  }
  await db.from("campaigns").update({ status: "paused", updated_at: now }).eq("id", campaignId);
  return { paused, errors };
}

/**
 * Permanently delete every Instantly sub-campaign of a master. Used when the user
 * deletes a campaign — "delete" should remove it from Instantly, not just pause it.
 * Best-effort per sub; the caller still soft-deletes the master row afterwards.
 */
export async function deleteCampaignInstantly(db: Db, campaignId: string): Promise<{ deleted: number; errors: string[] }> {
  const subs = await subCampaigns(db, campaignId);
  const errors: string[] = [];
  let deleted = 0;
  const now = new Date().toISOString();
  for (const sub of subs) {
    try {
      await deleteInstantlyCampaign(sub.instantly_campaign_id);
      // Mark our mirror row terminal and drop the now-dead Instantly id.
      await db.from("instantly_campaigns")
        .update({ status: "completed", instantly_campaign_id: null, updated_at: now })
        .eq("id", sub.id);
      deleted++;
    } catch (e) {
      errors.push(`sub ${sub.id}: ${(e as Error).message}`);
    }
  }
  return { deleted, errors };
}

/** Re-activate every sub-campaign of a paused master and mark it active again.
 *
 *  Clears the hold stamp too: resuming from anywhere (the campaign list, the
 *  Sequences banner) means sending is live again, so leaving sending_held_at
 *  set would keep showing a "held" banner over a campaign that is sending. */
export async function resumeCampaign(db: Db, campaignId: string): Promise<{ resumed: number; errors: string[] }> {
  const subs = await subCampaigns(db, campaignId);
  const errors: string[] = [];
  let resumed = 0;
  const now = new Date().toISOString();
  for (const sub of subs) {
    try {
      await activateInstantlyCampaign(sub.instantly_campaign_id);
      await db.from("instantly_campaigns").update({ status: "active", updated_at: now }).eq("id", sub.id);
      resumed++;
    } catch (e) {
      errors.push(`sub ${sub.id}: ${(e as Error).message}`);
    }
  }
  await db.from("campaigns").update({
    status: "active",
    sending_held_at: null,
    sending_held_by: null,
    updated_at: now,
  }).eq("id", campaignId);
  return { resumed, errors };
}

/**
 * Hold sending on a live campaign — a reversible stop someone can undo.
 *
 * Mechanically this IS pauseCampaign: Instantly has no per-step pause, so the
 * only lever available stops the whole campaign. What a hold adds is the record
 * of who pressed it and when, which is what the banner needs — a campaign that
 * is merely `paused` cannot be told apart from one abandoned days ago.
 *
 * Measured live on 2026-08-29: a paused campaign held a follow-up 14 minutes
 * past its due time and sent nothing, then released it 57 seconds after being
 * re-activated. Held mail is delayed, never lost — which is what makes this
 * safe to offer to every user rather than restricting it.
 *
 * Deliberately no auto-expiry. A hold that releases itself would send the very
 * email someone stopped, at a moment nobody is watching.
 */
export async function holdSending(
  db: Db,
  campaignId: string,
  userId: string,
): Promise<{ paused: number; errors: string[] }> {
  const result = await pauseCampaign(db, campaignId);
  await db.from("campaigns").update({
    sending_held_at: new Date().toISOString(),
    sending_held_by: userId,
  }).eq("id", campaignId);
  return result;
}

/**
 * Let sending go again once the follow-up rewrite that held it has finished.
 *
 * "Hold and regenerate" held sending and started the job, and nothing released
 * it afterwards: the person had to remember to press Resume, and one campaign
 * sat held for three days because nobody did. The hold was taken for the
 * rewrite, so the rewrite finishing is what should end it.
 *
 * Nothing records "this hold was taken for that job", so it is inferred: the
 * same person held sending within the fifteen minutes before starting the job.
 * A hold by someone else, or an older one, is a deliberate stop and stays put.
 *
 * The no-auto-expiry rule on holdSending still stands. This is not a timer; it
 * fires only when the job is done, and a lead the rewrite failed on keeps its
 * previous text, which was already going out before the hold.
 *
 * ponytail: inferred from timestamps. A resume_sending_on_complete column on
 * draft_regeneration_jobs would make it explicit, once DDL can be applied.
 */
export async function resumeIfHeldForJob(
  db: Db,
  job: { campaign_id: string; requested_by: string | null; created_at: string },
): Promise<boolean> {
  const { data: c } = await db
    .from("campaigns")
    .select("sending_held_at, sending_held_by")
    .eq("id", job.campaign_id)
    .maybeSingle();
  if (!holdWasForJob(c ?? null, job)) return false;
  await resumeCampaign(db, job.campaign_id);
  return true;
}

export const HOLD_FOR_JOB_WINDOW_MS = 15 * 60 * 1000;

/** The decision behind resumeIfHeldForJob, kept pure so it can be checked. */
export function holdWasForJob(
  hold: { sending_held_at: string | null; sending_held_by: string | null } | null,
  job: { requested_by: string | null; created_at: string },
): boolean {
  if (!hold?.sending_held_at || !job.requested_by || hold.sending_held_by !== job.requested_by) return false;
  const gap = Date.parse(job.created_at) - Date.parse(hold.sending_held_at);
  return gap >= 0 && gap <= HOLD_FOR_JOB_WINDOW_MS;
}
