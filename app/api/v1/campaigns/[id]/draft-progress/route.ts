import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { canDraftOpenings, countPendingDrafts } from "@/lib/services/generate-drafts";

type DraftRow = { status: string } | { status: string }[] | null;

function unwrapDraft(raw: DraftRow): { status: string } | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, company_id")
    .eq("id", id)
    .maybeSingle();

  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  const { data: rows } = await db
    .from("campaign_leads")
    .select("id, lead_id, email_drafts(status)")
    .eq("campaign_id", id);

  // The embed resolves through campaign_leads.draft_id, which is only repointed
  // once generation succeeds — so an in-flight draft shows up here as either no
  // row (first generation) or the previous row demoted to 'rejected'
  // (regeneration). Neither counts as work-in-progress, which stopped the
  // client's 3s poll mid-regeneration. Read the live rows directly instead.
  const { data: inFlight } = await db
    .from("email_drafts")
    .select("lead_id")
    .eq("campaign_id", id)
    .eq("status", "generating");
  const generatingLeadIds = new Set((inFlight ?? []).map((d) => d.lead_id as string));

  const statusCounts: Record<string, number> = {
    generating: 0,
    draft: 0,
    approved: 0,
    sent: 0,
    failed: 0,
    rejected: 0,
  };
  let pending = 0;

  for (const row of rows ?? []) {
    // An in-flight row wins over whatever draft_id still points at, so a lead is
    // never counted as both generating and pending.
    if (generatingLeadIds.has(row.lead_id as string)) {
      statusCounts.generating++;
      continue;
    }
    const draft = unwrapDraft(row.email_drafts as DraftRow);
    if (!draft) {
      pending++;
      continue;
    }
    const s = draft.status;
    if (s in statusCounts) statusCounts[s as keyof typeof statusCounts]++;
  }

  const realPending = Math.min(pending, Math.max(0, (await countPendingDrafts(db, id)) - statusCounts.generating));

  return ok({
    total: rows?.length ?? 0,
    generating: statusCounts.generating,
    draft: statusCounts.draft,
    approved: statusCounts.approved,
    sent: statusCounts.sent,
    failed: statusCounts.failed,
    // Leads a worker will still write. The loop's count also included leads it
    // never will (no email, retry cap reached), which kept the drawer polling
    // forever and would make the Send-all warning cry wolf.
    // countPendingDrafts includes in-flight rows, which are reported above.
    pending: realPending,
    // Only asked while something is waiting: false means drafting is paused
    // because the main model has no credits, which the drawer turns into the
    // "Drafting paused" bar with its two ways forward.
    ai_available: realPending > 0
      ? await canDraftOpenings(db, { id, name: campaign.name as string, company_id: campaign.company_id as string })
      : true,
  });
}
