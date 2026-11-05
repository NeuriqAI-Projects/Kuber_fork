import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CreateOrgSchema, OrgListQuerySchema } from "@/lib/validators/organizations";
import { normalizeDomain } from "@/lib/utils/domain";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Every column except scraped_markdown (the raw page text, up to ~100 KB per
// org): no screen reads it, and select("*") shipped it on every drawer open.
const ORG_COLUMNS =
  "id, apollo_org_id, domain, website, name, industry, keywords, employees, city, country, has_scraped, unsubscribed, created_at, updated_at, company_description, sells_to, enrichment_stage, enrichment_status, enrichment_started_at, enrichment_done_at, enrichment_attempts, last_error, domain_source, scraped_at, company_id";

// Organizations are enrichment territory — manager-only (planning.md D8).
// Employees reach org data only through their own leads' drawers
// (GET /organizations/[id], scoped there).
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = OrgListQuerySchema.safeParse(sp);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());

  const { search, industry, has_scraped, unsubscribed, page, limit } = parsed.data;
  const db = dbForUser(user);

  let q = db.from("organizations").select(ORG_COLUMNS, { count: "exact" });

  if (search) q = q.or(`name.ilike.%${search}%,domain.ilike.%${search}%`);
  if (industry) q = q.eq("industry", industry);
  if (has_scraped !== undefined) q = q.eq("has_scraped", has_scraped === "true");
  if (unsubscribed !== undefined) q = q.eq("unsubscribed", unsubscribed === "true");

  q = q.order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1);

  const { data, error, count } = await q;
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ organizations: data, total: count, page, limit });
}

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = CreateOrgSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { name, domain, ...rest } = parsed.data;
  const db = dbForUser(user);

  const normalizedDomain = domain ? (normalizeDomain(domain) || null) : null;

  // Dedup: try domain first, then name
  if (normalizedDomain) {
    const { data: existing } = await db
      .from("organizations")
      .select("id")
      .eq("domain", normalizedDomain)
      .maybeSingle();
    if (existing) return fail(409, "DUPLICATE", "Organization with this domain already exists", { id: existing.id });
  } else {
    const { data: existing } = await db
      .from("organizations")
      .select("id")
      .ilike("name", name)
      .maybeSingle();
    if (existing) return fail(409, "DUPLICATE", "Organization with this name already exists", { id: existing.id });
  }

  const { data, error } = await db
    .from("organizations")
    .insert({ name, domain: normalizedDomain, ...rest, created_at: new Date().toISOString() })
    .select(ORG_COLUMNS)
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  return ok(data);
}
