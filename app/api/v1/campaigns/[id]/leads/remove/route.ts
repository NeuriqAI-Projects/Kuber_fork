import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbId } from "@/lib/validators/id";

const BodySchema = z.object({ campaign_lead_ids: z.array(dbId).min(1).max(1000) });

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

  const { data: rows } = await db
    .from("campaign_leads")
    .select("id, lead_id, crm_status, first_sent_at, instantly_lead_id, leads!lead_id(assigned_to)")
    .eq("campaign_id", id)
    .in("id", parsed.data.campaign_lead_ids);

  const { data: sentDrafts } = await db
    .from("email_drafts")
    .select("lead_id")
    .eq("campaign_id", id)
    .eq("status", "sent")
    .in("lead_id", (rows ?? []).map((r) => r.lead_id as string));
  const alreadySent = new Set((sentDrafts ?? []).map((d) => d.lead_id as string));

  let removed = 0;
  const skipped: string[] = [];
  for (const r of rows ?? []) {
    const owner = (Array.isArray(r.leads) ? r.leads[0] : r.leads) as { assigned_to?: string | null } | null;
    const unsent = UNSENT.has(r.crm_status as string) && !r.first_sent_at && !r.instantly_lead_id && !alreadySent.has(r.lead_id as string);
    if (!unsent || (user.role === "employee" && owner?.assigned_to !== user.id)) {
      skipped.push(r.id as string);
      continue;
    }
    // The row points at its opening draft (campaign_leads_draft_id_fkey), so
    // the pointer goes first or the draft delete is refused.
    await db.from("campaign_leads").update({ draft_id: null }).eq("id", r.id);
    await db.from("email_drafts").delete().eq("campaign_id", id).eq("lead_id", r.lead_id).neq("status", "sent");
    const { error } = await db.from("campaign_leads").delete().eq("id", r.id);
    if (error) { skipped.push(r.id as string); continue; }
    removed++;
    await logLeadEvent(db, r.lead_id as string, "removed_from_campaign",
      `Removed from campaign "${campaign.name}" before anything was sent`,
      { actorId: user.id, metadata: { campaign_id: id } });
  }

  if (removed > 0) {
    const { count } = await db.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", id);
    await db.from("campaigns").update({ total_leads: count ?? 0, updated_at: new Date().toISOString() }).eq("id", id);
  }

  return ok({ removed, skipped: skipped.length });
}
