import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

/** Which statuses each tab shows. */
const VIEWS: Record<string, string[]> = {
  good: ["good", "waiting_credits", "promoted", "no_contact", "approved"],
  review: ["review", "flagged", "site_down"],
  hidden: ["hidden", "rejected"],
  working: ["queued", "read_social", "read"],
};

/** Recent searches, the chosen search's counts per tab, and that tab's companies. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "good";
  if (!VIEWS[view]) return fail(400, "VALIDATION_ERROR", `Unknown view "${view}"`);

  const { data: searches } = await db.from("prospect_searches")
    .select("id, filters, page, status, credits_spent, returned, new_companies, total_entries, error, mock, created_at")
    .order("created_at", { ascending: false }).limit(20);
  const searchId = url.searchParams.get("search_id") ?? (searches?.[0]?.id as string | undefined);
  if (!searchId) return ok({ searches: [], search_id: null, counts: {}, companies: [] });

  const { data: all } = await db.from("prospect_companies").select("status").eq("search_id", searchId);
  const counts: Record<string, number> = { good: 0, review: 0, hidden: 0, working: 0 };
  for (const r of all ?? []) for (const [v, sts] of Object.entries(VIEWS)) if (sts.includes(r.status as string)) counts[v]++;

  const { data: companies } = await db.from("prospect_companies")
    .select("id, name, domain, website_url, linkedin_url, status, score, reason, text_source, extra_sources, last_error, attempts, organization_id, updated_at")
    .eq("search_id", searchId).in("status", VIEWS[view])
    .order("score", { ascending: false, nullsFirst: false }).order("name").limit(200);

  return ok({ searches: searches ?? [], search_id: searchId, counts, companies: companies ?? [] });
}
