import type { createAdminClient } from "@/lib/supabase/admin";
import { deleteInstantlyLead } from "@/lib/services/instantly";
import { logLeadEvents } from "@/lib/services/lead-events";

type Db = ReturnType<typeof createAdminClient>;

/** Campaign name off the joined row, which PostgREST may hand back either shape. */
function campaignName(rel: unknown): string {
  const c = Array.isArray(rel) ? rel[0] : rel;
  return (c as { name?: string } | null)?.name ?? "a campaign";
}

export type LeadRemovalResult = {
  instantly_removed: number;
  instantly_errors: string[];
  memberships_closed: number;
  memberships_removed: number;
};

// Statuses that mean "nothing was ever sent for this membership" — safe to
// hard-remove so the lead simply vanishes from the campaign's kanban/counts.
const PRE_SEND_STATUSES = ["new", "enriching", "enriched", "draft", "draft_ready", "approved", "skipped", "failed"];

/**
 * Deleting a lead must actually stop outreach (planning.md Phase 5 / Q7):
 *   • memberships already pushed to Instantly → delete the Instantly lead
 *     (kills scheduled follow-ups) and close the membership (history kept);
 *   • memberships never sent → remove them and their unsent drafts entirely;
 *   • affected campaigns get their total_leads recounted.
 * Idempotent: re-running after a partial Instantly failure retries cleanly
 * (Instantly 404s are treated as already-removed).
 *
 * Note the intentional asymmetry (review §3.6): pre-send data is hard-deleted
 * because nothing else references it, but post-send `reply_events` /
 * `unibox_emails` / `reply_drafts` rows are left in place — they're real send
 * history, not working data, and every access path already scopes through
 * `campaign_leads`/`leads.is_deleted`, so a deleted lead's threads simply stop
 * being reachable rather than needing their own cleanup. If a future surface
 * ever reads those tables directly without going through that scoping, it
 * must check `is_deleted` itself.
 */
export async function removeLeadFromOutreach(db: Db, leadId: string): Promise<LeadRemovalResult> {
  return removeLeadsFromOutreach(db, [leadId]);
}

/** Ids per `.in()` filter: the list travels in the request URL (~37 bytes an
 *  id), and ~400 of them once overflowed the gateway's URL limit. */
const ID_CHUNK = 100;
/** Instantly deletes in flight at once (was one at a time, up to 500 leads). */
const INSTANTLY_CONCURRENCY = 5;

function chunks<T>(list: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** One retry after a pause on 429, so parallel deletes never leave a lead
 *  sending in Instantly just because we hit its rate limit. */
async function deleteInstantlyLeadPolitely(instantlyLeadId: string): Promise<void> {
  try {
    await deleteInstantlyLead(instantlyLeadId);
  } catch (e) {
    if (!/ 429:/.test((e as Error).message)) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    await deleteInstantlyLead(instantlyLeadId);
  }
}

/**
 * Set-based version for many leads at once (bulk delete): the same rows end
 * up changed and the same lead_events written as calling the one-lead flow per
 * lead, but with a few chunked queries instead of ~6 per membership, Instantly
 * deletes 5 at a time, and one events insert.
 */
export async function removeLeadsFromOutreach(db: Db, leadIds: string[]): Promise<LeadRemovalResult> {
  const result: LeadRemovalResult = {
    instantly_removed: 0,
    instantly_errors: [],
    memberships_closed: 0,
    memberships_removed: 0,
  };
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return result;
  const now = new Date().toISOString();
  const events: Parameters<typeof logLeadEvents>[1] = [];

  // These leads may have been someone else's bounce replacement. Deleting them
  // without clearing those pointers leaves the bounced row wearing a green
  // "Replaced" marker with nothing behind it — which tells the next person the
  // bounce is handled when it no longer is. Runs BEFORE the memberships below:
  // a replacement's own membership is hard-removed by the pre-send branch, so
  // on a re-run there is nothing left to iterate and the stale pointer would
  // survive forever.
  const pointed: Array<{ id: string; lead_id: string; campaign_id: string; replaced_by_lead_id: string }> = [];
  for (const c of chunks(ids)) {
    const { data } = await db.from("campaign_leads")
      .select("id, lead_id, campaign_id, replaced_by_lead_id")
      .in("replaced_by_lead_id", c);
    pointed.push(...((data ?? []) as typeof pointed));
  }
  for (const c of chunks(pointed.map((r) => r.id))) {
    await db.from("campaign_leads").update({ replaced_by_lead_id: null, updated_at: now }).in("id", c);
  }
  for (const row of pointed) {
    events.push({
      leadId: row.lead_id, event: "status_changed",
      detail: "Replacement contact was deleted — this bounce needs attention again",
      metadata: { campaign_id: row.campaign_id, deleted_replacement_lead_id: row.replaced_by_lead_id },
    });
  }

  type Membership = { id: string; lead_id: string; campaign_id: string; crm_status: string; instantly_lead_id: string | null; campaigns: unknown };
  const memberships: Membership[] = [];
  for (const c of chunks(ids)) {
    const { data } = await db.from("campaign_leads")
      .select("id, lead_id, campaign_id, crm_status, instantly_lead_id, campaigns(name)")
      .in("lead_id", c);
    memberships.push(...((data ?? []) as Membership[]));
  }
  if (memberships.length === 0) {
    await logLeadEvents(db, events);
    return result;
  }

  // Already in Instantly — stop future sends, keep the membership as history.
  // A failed delete still closes the membership below (the lead is deleted in
  // our system either way); re-running the delete retries the Instantly side.
  await eachLimited(memberships.filter((m) => m.instantly_lead_id), INSTANTLY_CONCURRENCY, async (m) => {
    try {
      await deleteInstantlyLeadPolitely(m.instantly_lead_id as string);
      result.instantly_removed++;
    } catch (e) {
      result.instantly_errors.push(`campaign_lead ${m.id}: ${(e as Error).message}`);
    }
  });

  const toClose: string[] = [];
  const preSend: Membership[] = [];
  for (const m of memberships) {
    if (m.instantly_lead_id || !PRE_SEND_STATUSES.includes(m.crm_status)) {
      // In Instantly, or a post-send status without an Instantly id (e.g.
      // replied via an unmapped path): close it, keep the history.
      if (m.crm_status !== "closed") {
        toClose.push(m.id);
        events.push({
          leadId: m.lead_id, event: "removed_from_campaign",
          detail: `Outreach stopped in "${campaignName(m.campaigns)}" — lead deleted`,
          metadata: { campaign_id: m.campaign_id, history_kept: true },
        });
      }
    } else {
      // Never sent — remove the membership and its unsent drafts entirely.
      preSend.push(m);
      events.push({
        leadId: m.lead_id, event: "removed_from_campaign",
        detail: `Removed from campaign "${campaignName(m.campaigns)}" — nothing had been sent yet`,
        metadata: { campaign_id: m.campaign_id },
      });
    }
  }

  for (const c of chunks(toClose)) {
    await db.from("campaign_leads").update({ crm_status: "closed", updated_at: now }).in("id", c);
  }
  result.memberships_closed = toClose.length;

  // Unsent drafts per campaign (a lead's drafts in a campaign where it was
  // already sent must stay, so never match leads across campaigns).
  const preSendLeadsByCampaign = new Map<string, string[]>();
  for (const m of preSend) preSendLeadsByCampaign.set(m.campaign_id, [...(preSendLeadsByCampaign.get(m.campaign_id) ?? []), m.lead_id]);
  for (const [campaignId, leadsInCampaign] of preSendLeadsByCampaign) {
    for (const c of chunks(leadsInCampaign)) {
      await db.from("email_drafts").delete().eq("campaign_id", campaignId).in("lead_id", c).neq("status", "sent");
    }
  }
  for (const c of chunks(preSend.map((m) => m.id))) {
    await db.from("campaign_leads").delete().in("id", c);
  }
  result.memberships_removed = preSend.length;

  await logLeadEvents(db, events);

  // Recount total_leads from ground truth for every affected campaign.
  await Promise.all([...new Set(memberships.map((m) => m.campaign_id))].map(async (campaignId) => {
    const { count } = await db
      .from("campaign_leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    await db.from("campaigns")
      .update({ total_leads: count ?? 0, updated_at: now })
      .eq("id", campaignId);
  }));

  return result;
}
