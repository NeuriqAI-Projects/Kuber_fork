import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { DraftsQuerySchema } from "@/lib/validators/drafts";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = DraftsQuerySchema.safeParse(sp);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());

  const { campaign_id, status, page, limit } = parsed.data;
  const db = dbForUser(user);

  let ownedCampaignIds: string[] | null = null;
  if (user.role === "employee") {
    const { data: owned } = await db.from("campaigns").select("id").eq("created_by", user.id);
    ownedCampaignIds = (owned ?? []).map((c) => c.id);
    if (campaign_id && !ownedCampaignIds.includes(campaign_id)) {
      return ok({ drafts: [], total: 0, page, limit });
    }
  }

  let q = db
    .from("email_drafts")
    .select(
      "*, leads(first_name, last_name, email, title, country, organizations(name, company_description, keywords))",
      { count: "exact" }
    );

  if (campaign_id) q = q.eq("campaign_id", campaign_id);
  else if (ownedCampaignIds) q = q.in("campaign_id", ownedCampaignIds);
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
