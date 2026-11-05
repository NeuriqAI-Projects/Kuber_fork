import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const orgId = req.nextUrl.searchParams.get("org_id");
  if (!orgId) return fail(400, "VALIDATION_ERROR", "org_id is required");

  const db = dbForUser(user);

  const { data: org, error } = await db
    .from("organizations")
    .select("enrichment_stage, enrichment_status, enrichment_attempts, company_description, sells_to, last_error")
    .eq("id", orgId)
    .single();

  if (error || !org) return fail(404, "NOT_FOUND", "Organization not found");

  // Never send payload to client — internal only
  const { data: logs } = await db
    .from("enrichment_logs")
    .select("event, source, duration_ms, error, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  return ok({
    enrichment_stage: org.enrichment_stage,
    enrichment_status: org.enrichment_status,
    enrichment_attempts: org.enrichment_attempts,
    company_description: org.company_description,
    sells_to: org.sells_to,
    last_error: org.last_error,
    logs: (logs ?? []).map((l) => ({
      event: l.event,
      source: l.source,
      duration_ms: l.duration_ms,
      error: l.error,
      created_at: l.created_at,
    })),
  });
}
