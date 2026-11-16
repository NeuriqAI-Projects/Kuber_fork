import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { DraftsQuerySchema } from "@/lib/validators/drafts";
import { dbForUser } from "@/lib/supabase/scoped";
import { getAccessibleCampaignIds } from "@/lib/auth/scope";
import { canSeeAll } from "@/lib/auth/scopes";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:read"); } catch (r) { return r as Response; }

  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = DraftsQuerySchema.safeParse(sp);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());

  const { campaign_id, status, page, limit } = parsed.data;
  const db = dbForUser(user);

  // Without campaigns:all: the campaigns they can open (getAccessibleCampaignIds,
  // same rule as the campaign list) and, inside them, only drafts on their own
  // leads — never a teammate's draft in a shared campaign.
  const seesAll = canSeeAll(user.member, "campaigns");
  let accessibleIds: string[] | null = null;
  if (!seesAll) {
    accessibleIds = await getAccessibleCampaignIds(db, user);
    if (campaign_id ? !accessibleIds.includes(campaign_id) : accessibleIds.length === 0) {
      return ok({ drafts: [], total: 0, page, limit });
    }
  }

  let q = db
    .from("email_drafts")
    .select(
      `*, leads${seesAll ? "" : "!inner"}(first_name, last_name, email, title, country, assigned_to, organizations(name, company_description, keywords))`,
      { count: "exact" }
    );

  if (!seesAll) q = q.eq("leads.assigned_to", user.id);
  if (campaign_id) q = q.eq("campaign_id", campaign_id);
  else if (accessibleIds) q = q.in("campaign_id", accessibleIds);
  if (status) q = q.eq("status", status);
  q = q.order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1);

  const { data, error, count } = await q;
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ drafts: data, total: count, page, limit });
}

/**
 * @deprecated — This inline POST generator is NOT called by the frontend.
 * The frontend uses POST /api/v1/campaigns/[id]/generate-drafts → lib/services/generate-drafts.ts.
 * Keeping GET for draft listing. POST returns 410 Gone to prevent accidental use.
 */
export async function POST() {
  return fail(
    410,
    "DEPRECATED",
    "This endpoint is deprecated. Use POST /api/v1/campaigns/{id}/generate-drafts instead.",
  );
}
