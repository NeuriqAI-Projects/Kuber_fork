import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { GROUPS, groupOf, isWorking, type Group } from "@/lib/services/prospects/groups";

const ROW_COLS = "id, search_id, name, domain, website_url, linkedin_url, status, score, score_confidence, reason, text_source, extra_sources, last_error, attempts, locked_until, decided_by, decided_at, organization_id, contact_apollo_id, created_at, updated_at";

/**
 * Scored companies for the Organizations tab (list + Kanban + running bar).
 *   ?search_ids=a,b   only these searches (default: the 20 most recent)
 *   ?groups=review    only these columns (checking,review,good,approved,declined,hidden)
 *   ?hidden=1         include Hidden when no groups are given
 *   ?q=acme           name/domain contains
 *   ?summary=1        searches + counts only (for the side-menu badge / running bar)
 * A search is at most 100 companies (one Apollo page), so 20 searches fit in a few reads.
 */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const sp = new URL(req.url).searchParams;
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const groups = list("groups").filter((g): g is Group => (GROUPS as readonly string[]).includes(g));
  const showHidden = sp.get("hidden") === "1";
  const q = (sp.get("q") ?? "").trim().toLowerCase();

  const { data: searchRows, error: sErr } = await db.from("prospect_searches")
    .select("id, filters, status, credits_spent, returned, new_companies, total_entries, error, mock, created_at, auto_reveals_used")
    .order("created_at", { ascending: false }).limit(20);
  if (sErr) return fail(500, "INTERNAL", sErr.message);
  const searches = searchRows ?? [];
  if (!searches.length) return ok({ searches: [], counts: emptyCounts(), companies: [], review_total: 0 });

  // Every company of the listed searches (light columns, paged past the 1,000-row cap).
  const ids = searches.map((s) => s.id as string);
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("prospect_companies").select(ROW_COLS).in("search_id", ids)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) return fail(500, "INTERNAL", error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const bySearch = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) (bySearch.get(r.search_id as string) ?? bySearch.set(r.search_id as string, []).get(r.search_id as string)!).push(r);

  const searchesOut = searches.map((s) => {
    const rs = bySearch.get(s.id as string) ?? [];
    const g = emptyCounts();
    for (const r of rs) g[groupOf(r as never)]++;
    const n = (...st: string[]) => rs.filter((r) => st.includes(r.status as string)).length;
    const f = (s.filters ?? {}) as { batch_name?: string; color?: string; keyword_labels?: string[]; keywords?: string[]; max_auto_reveals?: number };
    return {
      id: s.id, batch_name: f.batch_name ?? "Scored search", color: f.color ?? "green", keywords: f.keyword_labels ?? f.keywords ?? [],
      status: s.status, error: s.error, credits_spent: s.credits_spent, returned: s.returned, new_companies: s.new_companies,
      mock: s.mock, created_at: s.created_at, max_auto_reveals: f.max_auto_reveals ?? null, auto_reveals_used: s.auto_reveals_used,
      total: rs.length,
      in_progress: rs.filter((r) => isWorking(r as never)).length,
      groups: g,
      stages: {
        found: rs.length,
        read: rs.length - n("queued", "read_social"),
        scored: rs.length - n("queued", "read_social", "read"),
        to_reveal: n("good", "approved", "waiting_credits", "promoted", "no_contact"),
        revealed: n("promoted", "no_contact"),
        waiting_credits: n("waiting_credits"),
      },
    };
  });
  const reviewTotal = searchesOut.reduce((t, s) => t + s.groups.review, 0);
  if (sp.get("summary") === "1") return ok({ searches: searchesOut, counts: emptyCounts(), companies: [], review_total: reviewTotal });

  const wanted = list("search_ids");
  const inScope = rows.filter((r) => !wanted.length || wanted.includes(r.search_id as string))
    .filter((r) => !q || String(r.name).toLowerCase().includes(q) || String(r.domain ?? "").toLowerCase().includes(q));
  const counts = emptyCounts();
  for (const r of inScope) counts[groupOf(r as never)]++;
  const companies = inScope.filter((r) => {
    const grp = groupOf(r as never);
    return groups.length ? groups.includes(grp) : grp !== "hidden" || showHidden;
  });

  // The revealed contact for companies that reached the reveal step.
  const apolloIds = companies.map((r) => r.contact_apollo_id as string | null).filter((x): x is string => !!x);
  const contacts = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < apolloIds.length; i += 200) {
    const { data } = await db.from("leads").select("apollo_id, first_name, title, email").in("apollo_id", apolloIds.slice(i, i + 200)).eq("is_deleted", false);
    for (const l of data ?? []) contacts.set(l.apollo_id as string, l);
  }
  const meta = new Map(searchesOut.map((s) => [s.id as string, s]));
  return ok({
    searches: searchesOut,
    counts,
    review_total: reviewTotal,
    companies: companies.map((r) => ({
      ...r,
      group: groupOf(r as never),
      batch_name: meta.get(r.search_id as string)?.batch_name,
      batch_color: meta.get(r.search_id as string)?.color,
      contact: r.contact_apollo_id ? contacts.get(r.contact_apollo_id as string) ?? null : null,
    })),
  });
}

function emptyCounts(): Record<Group, number> {
  return { checking: 0, review: 0, good: 0, approved: 0, declined: 0, hidden: 0 };
}
