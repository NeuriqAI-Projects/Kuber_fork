import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "leads:read"); } catch (r) { return r as Response; }

  const orgId = req.nextUrl.searchParams.get("org_id");
  if (!orgId) return fail(400, "VALIDATION_ERROR", "org_id is required");

  const db = dbForUser(user);

  // Same rule as GET /organizations/[id]: without organizations:read, only an
  // org they own a lead under.
  if (!user.scopes.includes("organizations:read")) {
    const { data: own } = await db
      .from("leads")
      .select("id")
      .eq("organization_id", orgId)
      .eq("assigned_to", user.id)
      .eq("is_deleted", false)
      .limit(1)
      .maybeSingle();
    if (!own) return fail(404, "NOT_FOUND", "Organization not found");
  }

  const { data: org, error } = await db
    .from("organizations")
    .select("enrichment_stage, enrichment_status, enrichment_attempts, company_description, sells_to, last_error")
    .eq("id", orgId)
    .single();

  if (error || !org) return fail(404, "NOT_FOUND", "Organization not found");

  return ok({
    enrichment_stage: org.enrichment_stage,
    enrichment_status: org.enrichment_status,
    enrichment_attempts: org.enrichment_attempts,
    company_description: org.company_description,
    sells_to: org.sells_to,
    last_error: org.last_error,
    // The org's whole enrichment_logs trail used to ride along (unbounded, read
    // on every lead open); no screen shows it. Kept as an empty list so the
    // response shape does not change. The trail is in the DB when needed.
    logs: [],
  });
}
