import { NextRequest, after } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Rescrape spends Firecrawl/LLM credits — managers only. Employees never manage
// enrichment; they work whatever leads they're assigned (planning.md D8).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  const { data: org, error } = await db
    .from("organizations")
    .select("id, enrichment_stage, enrichment_attempts")
    .eq("id", id)
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  if (!org) return fail(404, "NOT_FOUND", "Organization not found");

  if (org.enrichment_stage === "scraping") {
    return fail(409, "IN_PROGRESS", "Enrichment is already running for this organization");
  }

  if (org.enrichment_stage !== "queued") {
    // The 3-attempt cap only governs automatic retries (route.ts's own
    // RETRYABLE_STATUSES loop). A manual rescrape is a deliberate human
    // action — most commonly triggered right after topping up OpenRouter/
    // Firecrawl credits — so it always gets a fresh attempt budget instead
    // of staying permanently blocked by MAX_ATTEMPTS.
    await db.from("organizations").update({
      has_scraped: false,
      enrichment_stage: "queued",
      enrichment_status: "SCRAPE_QUEUED",
      enrichment_attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", id);

    await db.from("enrichment_logs").insert({
      org_id: id,
      source: "system",
      event: "SCRAPE_QUEUED",
      payload: { triggered_by: "rescrape", previous_stage: org.enrichment_stage },
      created_at: new Date().toISOString(),
    });
  } else {
    await db.from("organizations").update({
      has_scraped: false,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
  }

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

  return ok({ id, queued_for_rescrape: true });
}
