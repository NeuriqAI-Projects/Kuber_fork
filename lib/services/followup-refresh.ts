import type { SupabaseClient } from "@supabase/supabase-js";
import { renderFollowupFallback } from "@/lib/services/settings";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";

/**
 * When a step's default text changes, rewrite the follow-ups already written
 * from the OLD default that have not gone out yet.
 *
 * Why: Instantly reads each lead's follow-up text from a variable at send time,
 * so an unsent follow-up can still be changed. Before this, editing a step's
 * text only reached follow-ups written afterwards. On 9 Oct 2026 the client
 * fixed a cut-short price-list email (PACKAGING GROUP 1, step 7) after 93
 * copies of the short version were already written; 87 of them had not been
 * sent and would have gone out short.
 *
 * Touched: approved follow-ups with source "template" (the default text).
 * Never touched:
 *   • already sent: Instantly told us (webhook or synced mail) this step left;
 *   • AI-written or hand-written (source ≠ template);
 *   • edited by hand after being written (a draft_edited event names it).
 */

export type RefreshDraft = { id: string; lead_id: string; body: string; source: string | null; version: number | null };

export interface RefreshPlan {
  toUpdate: RefreshDraft[];
  alreadySent: number;
  /** AI-written, hand-written or hand-edited — a person's or the AI's words, kept. */
  kept: number;
}

/** Pure: which drafts may be rewritten. One draft per lead (highest version). */
export function planRefresh(
  drafts: RefreshDraft[],
  sentLeadIds: Set<string>,
  editedDraftIds: Set<string>,
): RefreshPlan {
  const latest = new Map<string, RefreshDraft>();
  for (const d of drafts) {
    const cur = latest.get(d.lead_id);
    if (!cur || (d.version ?? 0) > (cur.version ?? 0)) latest.set(d.lead_id, d);
  }
  const plan: RefreshPlan = { toUpdate: [], alreadySent: 0, kept: 0 };
  for (const d of latest.values()) {
    if (sentLeadIds.has(d.lead_id)) plan.alreadySent++;
    else if (d.source !== "template" || editedDraftIds.has(d.id)) plan.kept++;
    else plan.toUpdate.push(d);
  }
  return plan;
}

export interface RefreshResult {
  step: number;
  updated: number;
  alreadySent: number;
  kept: number;
  /** Instantly refused the new text; these keep (and will send) the old one. */
  pushFailed: number;
}

type Push = (db: SupabaseClient, leadId: string, campaignId: string) => Promise<{ attempted: boolean; synced: boolean }>;

/** All rows of a query, past PostgREST's 1,000-row page. */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

function chunks<T>(xs: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function refreshTemplateFollowups(
  db: SupabaseClient,
  campaignId: string,
  stepOrder: number,
  template: string,
  push: Push = syncApprovedDraftToInstantly,
): Promise<RefreshResult> {
  const drafts = await all<RefreshDraft>((a, b) => db.from("email_drafts")
    .select("id, lead_id, body, source, version")
    .eq("campaign_id", campaignId).eq("step_number", stepOrder).eq("status", "approved")
    .order("id").range(a, b));
  if (drafts.length === 0) return { step: stepOrder, updated: 0, alreadySent: 0, kept: 0, pushFailed: 0 };

  const cls = await all<{ id: string; lead_id: string }>((a, b) => db.from("campaign_leads")
    .select("id, lead_id").eq("campaign_id", campaignId).order("id").range(a, b));
  const leadOfCl = new Map(cls.map((c) => [c.id, c.lead_id]));

  // Sent = Instantly said so, by either route (the webhook has had outages,
  // the mail sync can lag). Webhook steps are 1-based like step_order; synced
  // mail says "{sequence}_{0-based step}_{variant}".
  const sentLeadIds = new Set<string>();
  const webhook = await all<{ campaign_lead_id: string | null }>((a, b) => db.from("reply_events")
    .select("campaign_lead_id").eq("campaign_id", campaignId).eq("event_type", "email_sent").eq("step", stepOrder)
    .order("id").range(a, b));
  const synced = await all<{ campaign_lead_id: string | null }>((a, b) => db.from("unibox_emails")
    .select("campaign_lead_id").eq("campaign_id", campaignId).eq("direction", "sent_campaign")
    .filter("step", "match", `^[0-9]+_${stepOrder - 1}_[0-9]+$`)
    .order("id").range(a, b));
  for (const r of [...webhook, ...synced]) {
    const lead = r.campaign_lead_id ? leadOfCl.get(r.campaign_lead_id) : undefined;
    if (lead) sentLeadIds.add(lead);
  }

  const editedDraftIds = new Set<string>();
  for (const ids of chunks(drafts.map((d) => d.id))) {
    const { data } = await db.from("lead_events").select("metadata").eq("event", "draft_edited").in("metadata->>draft_id", ids);
    for (const e of data ?? []) editedDraftIds.add((e.metadata as { draft_id?: string } | null)?.draft_id ?? "");
  }

  const plan = planRefresh(drafts, sentLeadIds, editedDraftIds);

  const names = new Map<string, { first: string; last: string | null; company: string | null }>();
  for (const ids of chunks(plan.toUpdate.map((d) => d.lead_id))) {
    const { data } = await db.from("leads").select("id, first_name, last_name, organizations(name)").in("id", ids);
    for (const l of data ?? []) {
      const org = l.organizations as { name?: string | null } | { name?: string | null }[] | null;
      names.set(l.id as string, { first: (l.first_name as string | null) ?? "", last: l.last_name as string | null, company: (Array.isArray(org) ? org[0] : org)?.name ?? null });
    }
  }

  let updated = 0, pushFailed = 0;
  const now = new Date().toISOString();
  // ponytail: 8 Instantly PATCHes at a time inside the save request — ~10 s for
  // 500 leads. Move to a background job if campaigns grow past a few thousand.
  const queue = [...plan.toUpdate];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const n = names.get(d.lead_id);
      const body = renderFollowupFallback(template, n?.first ?? "", n?.company, n?.last);
      if (body === d.body) continue;
      // Conditional on the old body: a hand edit landing meanwhile wins.
      const { data: hit } = await db.from("email_drafts").update({ body, updated_at: now })
        .eq("id", d.id).eq("body", d.body).eq("status", "approved").select("id");
      if (!hit?.length) continue;
      const r = await push(db, d.lead_id, campaignId).catch(() => ({ attempted: true, synced: false }));
      if (r.attempted && !r.synced) {
        // Instantly still holds the old text and will send it: put ours back so
        // Kuber shows what will actually go out.
        await db.from("email_drafts").update({ body: d.body, updated_at: now }).eq("id", d.id).eq("body", body);
        pushFailed++;
      } else updated++;
    }
  }));

  return { step: stepOrder, updated, alreadySent: plan.alreadySent, kept: plan.kept, pushFailed };
}
