import { NextRequest } from "next/server";
import { requireAuth, requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchOrgSchema } from "@/lib/validators/organizations";
import { normalizeDomain } from "@/lib/utils/domain";
import { dbForUser } from "@/lib/supabase/scoped";
import { scoredForOrg } from "@/lib/services/prospects/groups";

export const maxDuration = 60;

// Every column except scraped_markdown (the raw page text, up to ~100 KB per
// org): no screen reads it, and select("*") shipped it on every drawer open.
const ORG_COLUMNS =
  "id, apollo_org_id, domain, website, name, industry, keywords, employees, city, country, has_scraped, unsubscribed, created_at, updated_at, company_description, sells_to, enrichment_stage, enrichment_status, enrichment_started_at, enrichment_done_at, enrichment_attempts, last_error, domain_source, scraped_at, company_id";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  // Employees may read an org only if they have a lead of their own under it
  // (spec §5) — everything else is manager territory.
  if (user.role === "employee") {
    const { data: assignedLead } = await db
      .from("leads")
      .select("id")
      .eq("organization_id", id)
      .eq("assigned_to", user.id)
      .eq("is_deleted", false)
      .limit(1)
      .maybeSingle();
    if (!assignedLead) return fail(404, "NOT_FOUND", "Organization not found");
  }

  const { data: org, error } = await db
    .from("organizations")
    .select(ORG_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  if (!org) return fail(404, "NOT_FOUND", "Organization not found");

  const { data: leads } = await db
    .from("leads")
    .select("id, apollo_id, first_name, last_name, email, email_status, title, lead_source, created_at")
    .eq("organization_id", id)
    .order("created_at", { ascending: false });

  // The scored-search row that found this company, if any (fit, why, status,
  // Approve / Decline in the drawer). Managers only: the scored tables are manager-scoped.
  const scored = user.role === "manager" ? await scoredForOrg(db, id, leads ?? []) : null;

  return ok({ ...org, leads: leads ?? [], scored });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchOrgSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  // This route previously spread `domain` straight into the update with no
  // normalization at all — the least-guarded of the four org-domain write
  // paths (manual "Edit org" form reaches this via PATCH). Route it through
  // the same hardened normalizeDomain() everything else uses.
  const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  if (parsed.data.domain !== undefined) {
    updates.domain = normalizeDomain(parsed.data.domain) || null;
  }

  const { data, error } = await db
    .from("organizations")
    .update(updates)
    .eq("id", id)
    .select(ORG_COLUMNS)
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  if (!data) return fail(404, "NOT_FOUND", "Organization not found");

  return ok(data);
}
