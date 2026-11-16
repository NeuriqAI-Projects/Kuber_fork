import { NextRequest, after } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Spends Firecrawl/LLM like /organizations/[id]/rescrape, so the same
// organizations:write scope (it used to be open to every member).
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "organizations:write"); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const orgId = body?.org_id;
  if (!orgId || typeof orgId !== "string") return fail(400, "VALIDATION_ERROR", "org_id is required");

  const db = dbForUser(user);

  const { data: org, error } = await db
    .from("organizations")
    .select("enrichment_stage, enrichment_attempts")
    .eq("id", orgId)
    .single();

  if (error || !org) return fail(404, "NOT_FOUND", "Organization not found");
  if (org.enrichment_stage === "scraping") {
    return fail(409, "IN_PROGRESS", "Enrichment is already running for this organization");
  }
  if ((org.enrichment_attempts ?? 0) >= 3) {
    return fail(409, "MAX_ATTEMPTS", "This organization has reached the maximum retry limit (3 attempts)");
  }

  // If already queued, just re-fire scrape-orgs without touching the DB
  if (org.enrichment_stage !== "queued") {
    await db.from("organizations").update({
      enrichment_stage: "queued",
      enrichment_status: "SCRAPE_QUEUED",
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", orgId);

    await db.from("enrichment_logs").insert({
      org_id: orgId,
      source: "system",
      event: "SCRAPE_QUEUED",
      payload: { triggered_by: "manual_retry", previous_stage: org.enrichment_stage },
      created_at: new Date().toISOString(),
    });
  }

  // Re-trigger scrape
  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  return ok({ queued: true });
}
