import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { checkTavilyCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";
import { loadProspectUsage, tavilyCallsOf, windows, LOOKBACK_DAYS } from "@/lib/services/prospects/usage";

// Live balance comes from Tavily's own /usage. The activity below is what Scored Companies
// recorded: LinkedIn/social pages read through Tavily (website down) and web searches used when
// the AI was unsure. A read that came back too thin is not recorded, so this can undercount slightly.
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);

  let rows;
  try { rows = (await loadProspectUsage(db)).filter((r) => { const c = tavilyCallsOf(r); return c.linkedin + c.search > 0; }); }
  catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  const key = await checkTavilyCredits(db, user.companyId ?? "any", { fresh: bypassCache });

  const calls = windows(rows, (r) => { const c = tavilyCallsOf(r); return c.linkedin + c.search; });
  const linkedin = windows(rows, (r) => tavilyCallsOf(r).linkedin);
  const search = windows(rows, (r) => tavilyCallsOf(r).search);
  const limit = key.limit ?? null;
  return ok({
    key,
    credits: { remaining: key.remaining, planCredits: limit, used: key.remaining != null && limit != null ? Math.max(0, limit - key.remaining) : null },
    calls: { today: calls.today, week: calls.week, month: calls.month, allTime: calls.allTime },
    split: { linkedinReads: linkedin.allTime, webSearches: search.allTime },
    daily: calls.daily.map((d, i) => ({ date: d.date, linkedin: linkedin.daily[i].value, searches: search.daily[i].value })),
    history: rows.slice(0, 50).map((r) => { const c = tavilyCallsOf(r); return { id: r.id, created_at: r.updated_at, name: r.name, linkedinRead: c.linkedin === 1, webSearch: c.search === 1, status: r.status }; }),
    ledgerWindowDays: LOOKBACK_DAYS,
  });
}
