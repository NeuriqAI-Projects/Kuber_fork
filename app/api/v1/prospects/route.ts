import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { companiesFilter, GROUPS, groupOf, isWorking, NO_TITLE_MATCH, type Group } from "@/lib/services/prospects/groups";
import { liveRunNote } from "@/lib/services/prospects/digging";

// The list's columns (only what the screens read: a row came to ~730 bytes with the rest), plus the
// org's leads, so the revealed contact comes in the same read (no second round trip).
const ROW_COLS = "id, search_id, name, domain, website_url, linkedin_url, status, score, reason, text_source, last_error, attempts, decided_by, organization_id, contact_apollo_id, organizations(leads(apollo_id, first_name, title, email, is_deleted))";
// Light columns for the progress numbers of the searches shown in detail.
const LIGHT_COLS = "search_id, name, domain, status, decided_by, text_source, score_confidence, attempts, last_error";
const PAGE = 1000;
/** Searches with full progress numbers (the running bar, the Started screen); older ones are only listed. */
const DETAILED = 20;
/** Rows per list answer; "Show more" asks for more (up to MAX_LIMIT). */
const LIMIT = 300, MAX_LIMIT = 3000;
const GOODISH = ["good", "waiting_credits", "no_contact", "promoted"];

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
 *   ?search_ids=a,b   only these searches (default: every search of the company)
 *   ?groups=review    only these columns (checking,review,good,approved,declined,hidden)
 *   ?hidden=1         include Hidden when no groups are given
 *   ?waiting=1        also "Waiting for credits" companies (a part of Good fit / Approved), beside any groups
 *   ?q=acme           name/domain contains (Hidden ones too)
 *   ?orgs=1           only companies that already have an organization (all the plain Organization list needs)
 *   ?limit=300        the newest N companies of the filter; `total_matching` says how many match
 *   ?summary=1        searches + review total only (for the side-menu badge / Started screen)
 *
 * Every search counts (24 Oct 2026; it was only the 20 newest, so ~3,000 older review companies were
 * invisible and the "need review" number went down as searches were added): `all_counts` and
 * `review_total` are head-only count queries, `batches` lists every search for the Batch filter, and
 * the list is the newest `limit` rows of the filter. Full progress numbers (`searches`) only for the
 * 20 newest searches plus any asked for in ?search_ids.
 * Two round trips: (all searches, the counts, the list) side by side, then the detailed searches' rows.
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
  const summary = sp.get("summary") === "1";
  const q = (sp.get("q") ?? "").trim().toLowerCase();
  const wanted = list("search_ids").filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(sp.get("limit"))) || LIMIT));

  // Company-wide numbers per group: head-only counts, no rows are downloaded.
  const count = async (f: (b: ReturnType<typeof head>) => PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await f(head());
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const head = () => db.from("prospect_companies").select("id", { count: "exact", head: true });
  const REVIEW = ["review", "flagged", "site_down"];
  const countsP = Promise.all(summary
    ? [count((b) => b.in("status", REVIEW))]
    : [
      count((b) => b.in("status", ["queued", "read_social", "read"])),
      count((b) => b.in("status", REVIEW)),
      count((b) => b.in("status", GOODISH).is("decided_by", null)),
      count((b) => b.in("status", ["approved", ...GOODISH])),
      count((b) => b.eq("status", "rejected")),
      count((b) => b.eq("status", "hidden")),
      count((b) => b.eq("status", "waiting_credits")),
    ]);
  // The list does not need the searches first, so it runs in the same round trip.
  const listP = (async () => {
    if (summary) return { rows: [] as Rows, total: 0 };
    let qb = db.from("prospect_companies").select(ROW_COLS, { count: "exact" });
    if (wanted.length) qb = qb.in("search_id", wanted);
    const or = companiesFilter(groups, waiting, q);
    if (or) qb = qb.or(or);
    if (!groups.length && !waiting && !showHidden && !q) qb = qb.neq("status", "hidden");
    if (orgsOnly && !q) qb = qb.not("organization_id", "is", null);
    const { data, error, count: total } = await qb.order("created_at", { ascending: false }).order("id").range(0, limit - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as unknown as Rows, total: total ?? 0 };
  })();
  // ponytail: the newest 1,000 searches are listed; page the Batch filter if a company ever has more.
  const searchesP = db.from("prospect_searches").select("*").order("created_at", { ascending: false }).limit(1000);

  let searches: Rows, c: number[], listed: { rows: Rows; total: number };
  try {
    const [s, cs, l] = await Promise.all([searchesP, countsP, listP]);
    if (s.error) throw new Error(s.error.message);
    searches = (s.data ?? []) as Rows; c = cs; listed = l;
  } catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  mark("searches+counts+list");
  const reviewTotal = summary ? c[0] : c[1];
  const allCounts = summary ? null : {
    checking: c[0], review: c[1], good: c[2], approved: c[3] - c[2], declined: c[4], hidden: c[5], waiting: c[6],
  };
  if (!searches.length) return ok({ searches: [], batches: [], counts: emptyCounts(), all_counts: allCounts, companies: [], review_total: 0, total_matching: 0 });

  const meta = (s: Record<string, unknown>) => (s.filters ?? {}) as { batch_name?: string; color?: string; keyword_labels?: string[]; keywords?: string[]; max_auto_reveals?: number; request_id?: string; job_titles?: string[] };
  const detailed = searches.filter((s, i) => i < DETAILED || wanted.includes(s.id as string));
  let rows: Rows;
  try {
    rows = await readAll((from, to) => db.from("prospect_companies").select(LIGHT_COLS).in("search_id", detailed.map((s) => s.id as string)).order("id").range(from, to));
  } catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  mark("rows");

  const bySearch = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) (bySearch.get(r.search_id as string) ?? bySearch.set(r.search_id as string, []).get(r.search_id as string)!).push(r);

  const searchesOut = detailed.map((s) => {
    const rs = bySearch.get(s.id as string) ?? [];
    const g = emptyCounts();
    for (const r of rs) g[groupOf(r as never)]++;
    const n = (...st: string[]) => rs.filter((r) => st.includes(r.status as string)).length;
    const f = meta(s);
    // Past reading but no text = the website (and socials) could not be read; past scoring with no
    // AI answer = could not be checked. Counted apart, so an outage never shows a full bar.
    const pastRead = rs.filter((r) => !["queued", "read_social"].includes(r.status as string));
    const pastScore = pastRead.filter((r) => r.status !== "read");
    return {
      id: s.id as string, batch_name: f.batch_name ?? "Scored search", color: f.color ?? "green", keywords: f.keyword_labels ?? f.keywords ?? [],
      request_id: f.request_id ?? null,
      status: s.status, error: s.error, credits_spent: s.credits_spent, returned: s.returned, new_companies: s.new_companies,
      mock: s.mock, created_at: s.created_at, max_auto_reveals: f.max_auto_reveals ?? null, auto_reveals_used: s.auto_reveals_used,
      total: rs.length,
      // Apollo credits this batch has really used: the search page + 1 per contact revealed.
      credits_used: ((s.credits_spent as number | null) ?? 0) + (s.mock ? 0 : n("promoted")),
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
      job_titles: (f.job_titles ?? []).filter(Boolean),
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
        // Read, not scored, and the AI already failed on it: the Started screen says "Retrying" at once.
        ai_retrying: rs.filter((r) => r.status === "read" && ((r.attempts as number | null) ?? 0) > 0 && /JEV/i.test(String(r.last_error ?? ""))).length,
      },
    };
  });
  // Every search, for the Batch filter; only the detailed ones carry a company count.
  const sizes = new Map(searchesOut.map((s) => [s.id, s.in_progress > 0 ? "running" : s.total] as const));
  const batches = searches.map((s) => ({
    id: s.id as string, batch_name: meta(s).batch_name ?? "Scored search", color: meta(s).color ?? "green",
    created_at: s.created_at as string, size: sizes.get(s.id as string) ?? null,
  }));
  mark("counts");
  if (summary) return timed(ok({ searches: searchesOut, batches, counts: emptyCounts(), all_counts: null, companies: [], review_total: reviewTotal, total_matching: 0 }));

  const matchesQ = (r: Record<string, unknown>) => !q || String(r.name).toLowerCase().includes(q) || String(r.domain ?? "").toLowerCase().includes(q);
  const picked = listed.rows.filter(matchesQ);
  // Column numbers: with a batch filter, those batches' rows (they are detailed); without one, the
  // whole company from the count queries.
  // ponytail: a name search without a batch filter counts only the rows listed; it rarely passes the limit.
  const counts = emptyCounts();
  if (wanted.length) { for (const r of rows) if (wanted.includes(r.search_id as string) && matchesQ(r)) counts[groupOf(r as never)]++; }
  else if (q) { for (const r of picked) counts[groupOf(r as never)]++; }
  else if (allCounts) for (const g of GROUPS) counts[g] = allCounts[g];
  mark("list");
  const byId = new Map(batches.map((b) => [b.id, b]));
  const titles = new Map(searches.map((s) => [s.id as string, (meta(s).job_titles ?? []).filter(Boolean)]));
  return timed(ok({
    searches: searchesOut,
    batches,
    counts,
    all_counts: allCounts,
    review_total: reviewTotal,
    total_matching: listed.total,
    companies: picked.map(({ organizations, ...r }) => {
      // The revealed contact is one of the org's leads.
      const leads = ((organizations as { leads?: Record<string, unknown>[] } | null)?.leads ?? []);
      const l = r.contact_apollo_id ? leads.find((x) => x.apollo_id === r.contact_apollo_id && !x.is_deleted) : null;
      return {
        ...r,
        group: groupOf(r as never),
        batch_name: byId.get(r.search_id as string)?.batch_name,
        batch_color: byId.get(r.search_id as string)?.color,
        // Only where nobody had one of them: the status line names them.
        ...(String(r.last_error ?? "").startsWith(NO_TITLE_MATCH) ? { job_titles: titles.get(r.search_id as string) ?? [] } : {}),
        contact: l ? { apollo_id: l.apollo_id, first_name: l.first_name, title: l.title, email: l.email } : null,
      };
    }),
  }));
}

function emptyCounts(): Record<Group, number> {
  return { checking: 0, review: 0, good: 0, approved: 0, declined: 0, hidden: 0 };
}
