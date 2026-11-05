import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { logLeadEvents } from "@/lib/services/lead-events";
import { dbId } from "@/lib/validators/id";

export const maxDuration = 60;

const BodySchema = z.object({ campaign_lead_ids: z.array(dbId).min(1).max(1000) });

/** Ids per `.in()` (they travel in the URL, ~37 bytes each). */
function chunks<T>(list: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Statuses a lead can be in before anything has gone out to it. */
const UNSENT = new Set(["new", "enriched", "draft", "approved", "failed"]);

/**
 * Take leads out of ONE campaign before anything has been sent to them.
 *
 * Until now the only way was deleting the lead from the whole system, which is
 * how six US leads were taken out of a Latin America campaign by hand on
 * 24 Sep 2026. The lead itself is kept and can go into another campaign.
 *
 * A lead that has been sent to, or handed to Instantly, is refused: removing it
 * here would not unsend anything, and its history belongs to this campaign.
 * Employees can only remove their own leads, the same rule Send follows.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { data: campaign } = await db.from("campaigns").select("id, name").eq("id", id).maybeSingle();
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  // Chunked reads (1,000 ids in one .in() is ~37 KB of URL — the gateway refuses
  // it and the request read as "nothing to remove"), then set-based writes.
  type Row = { id: string; lead_id: string; crm_status: string; first_sent_at: string | null; instantly_lead_id: string | null; leads: unknown };
  const rows: Row[] = [];
  for (const ids of chunks(parsed.data.campaign_lead_ids)) {
    const { data } = await db
      .from("campaign_leads")
      .select("id, lead_id, crm_status, first_sent_at, instantly_lead_id, leads!lead_id(assigned_to)")
      .eq("campaign_id", id)
      .in("id", ids);
    rows.push(...((data ?? []) as Row[]));
  }

  const alreadySent = new Set<string>();
  for (const ids of chunks(rows.map((r) => r.lead_id))) {
    const { data: sentDrafts } = await db
      .from("email_drafts")
      .select("lead_id")
      .eq("campaign_id", id)
      .eq("status", "sent")
      .in("lead_id", ids);
    for (const d of sentDrafts ?? []) alreadySent.add(d.lead_id as string);
  }

  const skipped: string[] = [];
  const removable: Row[] = [];
  for (const r of rows) {
    const owner = (Array.isArray(r.leads) ? r.leads[0] : r.leads) as { assigned_to?: string | null } | null;
    const unsent = UNSENT.has(r.crm_status) && !r.first_sent_at && !r.instantly_lead_id && !alreadySent.has(r.lead_id);
    if (!unsent || (user.role === "employee" && owner?.assigned_to !== user.id)) skipped.push(r.id);
    else removable.push(r);
  }

  const removedRows: Row[] = [];
  for (const part of chunks(removable)) {
    const ids = part.map((r) => r.id);
    // The row points at its opening draft (campaign_leads_draft_id_fkey), so
    // the pointer goes first or the draft delete is refused.
    await db.from("campaign_leads").update({ draft_id: null }).in("id", ids);
    await db.from("email_drafts").delete().eq("campaign_id", id).in("lead_id", part.map((r) => r.lead_id)).neq("status", "sent");
    const { error } = await db.from("campaign_leads").delete().in("id", ids);
    if (!error) { removedRows.push(...part); continue; }
    // One row refusing (e.g. a new FK) must not block the rest: retry one by one, as before.
    for (const r of part) {
      const { error: rowError } = await db.from("campaign_leads").delete().eq("id", r.id);
      if (rowError) skipped.push(r.id); else removedRows.push(r);
    }
  }
  const removed = removedRows.length;
  await logLeadEvents(db, removedRows.map((r) => ({
    leadId: r.lead_id, event: "removed_from_campaign" as const,
    detail: `Removed from campaign "${campaign.name}" before anything was sent`,
    actorId: user.id, metadata: { campaign_id: id },
  })));

  if (removed > 0) {
    const { count } = await db.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", id);
    await db.from("campaigns").update({ total_leads: count ?? 0, updated_at: new Date().toISOString() }).eq("id", id);
  }

  return ok({ removed, skipped: skipped.length });
}
