import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { GROUPS, groupOf, isWorking, type Group } from "@/lib/services/prospects/groups";
import { liveRunNote } from "@/lib/services/prospects/digging";

// The list's columns (only what the screens read: a row came to ~730 bytes with the rest), plus the
// org's leads, so the revealed contact comes in the same read (no second round trip).
const ROW_COLS = "id, search_id, name, domain, website_url, linkedin_url, status, score, reason, text_source, last_error, attempts, decided_by, organization_id, contact_apollo_id, organizations(leads(apollo_id, first_name, title, email, is_deleted))";
// Light columns for counting every company of the listed searches.
const LIGHT_COLS = "search_id, name, domain, status, decided_by, text_source, score_confidence";
const PAGE = 1000;
const GOODISH = ["good", "waiting_credits", "no_contact", "promoted"];
/** Statuses a group can hold (good/approved split on decided_by, checked exactly afterwards). */
const STATUSES: Record<Group, string[]> = {
  checking: ["queued", "read_social", "read"], review: ["review", "flagged", "site_down"], good: GOODISH,
  approved: ["approved", ...GOODISH], declined: ["rejected"], hidden: ["hidden"],
};

type Rows = Record<string, unknown>[];
type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
/** Every row of a query, paged past the 1,000-row cap. */
async function readAll(page: (from: number, to: number) => Page): Promise<Rows> {
  const out: Rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Rows));
    if ((data ?? []).length < PAGE) return out;
  }
}

/**
 * Scored companies for the Organizations tab (list + Kanban + running bar).
 *   ?search_ids=a,b   only these searches (default: the 20 most recent)
 *   ?groups=review    only these columns (checking,review,good,approved,declined,hidden)
 *   ?hidden=1         include Hidden when no groups are given
 *   ?waiting=1        also "Waiting for credits" companies (a part of Good fit / Approved), beside any groups
 *   ?q=acme           name/domain contains (Hidden ones too)
 *   ?orgs=1           only companies that already have an organization (all the plain Organization list needs)
 *   ?summary=1        searches + counts only (for the side-menu badge / running bar)
 *
 * Speed (23 Oct 2026): every company of 20 searches (now up to 20 pages each) was read with all
 * columns, then the contacts one batch after another. Now two reads side by side: light columns
 * for the counts, and full rows (with their contact) only for what the filter can return.
 * The Server-Timing header shows where the time went.
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const lap: string[] = [];
  const mark = (n: string) => lap.push(`${n};dur=${Date.now() - t0}`);
  const timed = (res: Response) => { res.headers.set("Server-Timing", lap.join(", ")); return res; };
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  mark("auth");
  const db = dbForUser(user);
  const sp = new URL(req.url).searchParams;
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const groups = list("groups").filter((g): g is Group => (GROUPS as readonly string[]).includes(g));
  const showHidden = sp.get("hidden") === "1";
  const waiting = sp.get("waiting") === "1";
  const orgsOnly = sp.get("orgs") === "1";
  const q = (sp.get("q") ?? "").trim().toLowerCase();

  const { data: searchRows, error: sErr } = await db.from("prospect_searches")
    .select("*") // newer columns (lead target, page memory) appear once their migration has run
    .order("created_at", { ascending: false }).limit(20);
  if (sErr) return fail(500, "INTERNAL", sErr.message);
  mark("searches");
  const searches = searchRows ?? [];
  if (!searches.length) return ok({ searches: [], counts: emptyCounts(), companies: [], review_total: 0 });

  const ids = searches.map((s) => s.id as string);
  const summary = sp.get("summary") === "1";
  const wanted = list("search_ids");
  const scopeIds = wanted.length ? ids.filter((id) => wanted.includes(id)) : ids;
  // Narrowed in the database to a superset of what the filter shows; the exact rules run below.
  const listQuery = (from: number, to: number) => {
    let qb = db.from("prospect_companies").select(ROW_COLS).in("search_id", scopeIds);
    if (groups.length || waiting) qb = qb.in("status", [...new Set([...groups.flatMap((g) => STATUSES[g]), ...(waiting ? ["waiting_credits"] : [])])]);
    else if (!showHidden && !q) qb = qb.neq("status", "hidden");
    if (orgsOnly && !q) qb = qb.not("organization_id", "is", null);
    // Only plain words go into the filter text; anything else is matched below only.
    if (q && /^[\p{L}\p{N} .\-]+$/u.test(q)) qb = qb.or(`name.ilike.*${q}*,domain.ilike.*${q}*`);
    return qb.order("created_at", { ascending: true }).order("id").range(from, to);
  };
  let rows: Rows, listed: Rows;
  try {
    [rows, listed] = await Promise.all([
      readAll((from, to) => db.from("prospect_companies").select(LIGHT_COLS).in("search_id", ids).order("id").range(from, to)),
      summary || !scopeIds.length ? Promise.resolve([]) : readAll(listQuery),
    ]);
  } catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  mark("rows");

  const bySearch = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) (bySearch.get(r.search_id as string) ?? bySearch.set(r.search_id as string, []).get(r.search_id as string)!).push(r);

  const searchesOut = searches.map((s) => {
    const rs = bySearch.get(s.id as string) ?? [];
    const g = emptyCounts();
    for (const r of rs) g[groupOf(r as never)]++;
    const n = (...st: string[]) => rs.filter((r) => st.includes(r.status as string)).length;
    const f = (s.filters ?? {}) as { batch_name?: string; color?: string; keyword_labels?: string[]; keywords?: string[]; max_auto_reveals?: number; request_id?: string };
    // Past reading but no text = the website (and socials) could not be read; past scoring with no
    // AI answer = could not be checked. Counted apart, so an outage never shows a full bar.
    const pastRead = rs.filter((r) => !["queued", "read_social"].includes(r.status as string));
    const pastScore = pastRead.filter((r) => r.status !== "read");
    return {
      id: s.id, batch_name: f.batch_name ?? "Scored search", color: f.color ?? "green", keywords: f.keyword_labels ?? f.keywords ?? [],
      request_id: f.request_id ?? null,
      status: s.status, error: s.error, credits_spent: s.credits_spent, returned: s.returned, new_companies: s.new_companies,
      mock: s.mock, created_at: s.created_at, max_auto_reveals: f.max_auto_reveals ?? null, auto_reveals_used: s.auto_reveals_used,
      total: rs.length,
      // Apollo credits this batch has really used: the search page + 1 per contact revealed.
      credits_used: (s.credits_spent ?? 0) + (s.mock ? 0 : n("promoted")),
      // The limit chosen on the search screen (search + automatic reveals); approvals add 1 each.
      max_credits: (s.max_credits as number | null) ?? (f.max_auto_reveals != null && !s.target_leads ? f.max_auto_reveals + 1 : null),
      target_leads: (s.target_leads as number | null) ?? null,
      leads: n("promoted"),
      pages: (s.pages as number[] | null) ?? [],
      run_status: (s.run_status as string | null) ?? "complete",
      // Written when the run stopped; leads that came later (top-up, approvals) are counted in.
      run_note: liveRunNote({
        note: (s.run_note as string | null) ?? null, leads: n("promoted"), target: (s.target_leads as number | null) ?? null,
        approved: rs.filter((r) => r.status === "promoted" && r.decided_by).length, waiting: n("waiting_credits"),
      }),
      job_titles: ((s.filters as { job_titles?: string[] } | null)?.job_titles ?? []).filter(Boolean),
      // A search still reading pages counts as in progress even between pages.
      in_progress: rs.filter((r) => isWorking(r as never)).length + (s.run_status === "running" ? 1 : 0),
      groups: g,
      stages: {
        found: rs.length,
        read: pastRead.filter((r) => r.text_source).length,
        read_failed: pastRead.filter((r) => !r.text_source).length,
        scored: pastScore.filter((r) => r.score_confidence != null).length,
        score_failed: pastScore.filter((r) => r.score_confidence == null).length,
        to_reveal: n("good", "approved", "waiting_credits", "promoted", "no_contact"),
        revealed: n("promoted", "no_contact"),
        waiting_credits: n("waiting_credits"),
      },
    };
  });
  // Like every count here, only the 20 most recent searches (the ones the page lists).
  const reviewTotal = searchesOut.reduce((t, s) => t + s.groups.review, 0);
  mark("counts");
  if (summary) return timed(ok({ searches: searchesOut, counts: emptyCounts(), companies: [], review_total: reviewTotal }));

  const matchesQ = (r: Record<string, unknown>) => !q || String(r.name).toLowerCase().includes(q) || String(r.domain ?? "").toLowerCase().includes(q);
  // A name search finds a company in every group, Hidden included.
  const counts = emptyCounts();
  for (const r of rows) if (scopeIds.includes(r.search_id as string) && matchesQ(r)) counts[groupOf(r as never)]++;
  const picked = listed.filter(matchesQ).filter((r) => {
    if (orgsOnly && !q && !r.organization_id) return false;
    const grp = groupOf(r as never);
    if (groups.length || waiting) return groups.includes(grp) || (waiting && r.status === "waiting_credits");
    return grp !== "hidden" || showHidden || !!q;
  });
  mark("list");
  const meta = new Map(searchesOut.map((s) => [s.id as string, s]));
  return timed(ok({
    searches: searchesOut,
    counts,
    review_total: reviewTotal,
    companies: picked.map(({ organizations, ...r }) => {
      // The revealed contact is one of the org's leads.
      const leads = ((organizations as { leads?: Record<string, unknown>[] } | null)?.leads ?? []);
      const l = r.contact_apollo_id ? leads.find((x) => x.apollo_id === r.contact_apollo_id && !x.is_deleted) : null;
      return {
        ...r,
        group: groupOf(r as never),
        batch_name: meta.get(r.search_id as string)?.batch_name,
        batch_color: meta.get(r.search_id as string)?.color,
        contact: l ? { apollo_id: l.apollo_id, first_name: l.first_name, title: l.title, email: l.email } : null,
      };
    }),
  }));
}

function emptyCounts(): Record<Group, number> {
  return { checking: 0, review: 0, good: 0, approved: 0, declined: 0, hidden: 0 };
}
