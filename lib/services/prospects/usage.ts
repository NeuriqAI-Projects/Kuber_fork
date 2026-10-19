// What Scored Companies has spent on Jev (the AI) and Tavily (web search / LinkedIn reader),
// counted from prospect_companies. Neither provider is logged call by call, but every
// scored company records its Jev tokens, where its text came from and which extra
// sources were used, which is enough for "what did this app use".
import type { SupabaseClient } from "@supabase/supabase-js";
import { JEV_USD_PER_MTOK } from "./jev";

export interface ProspectUsageRow {
  id: string; name: string; status: string; score: number | null; updated_at: string;
  jev_tokens: number; text_source: string | null; extra_sources: string[] | null;
}

export const LOOKBACK_DAYS = 90;
export const DAILY_CHART_DAYS = 14;

/** Rows touched in the last 90 days that used Jev or Tavily, newest first (pages past Supabase's 1,000-row cap). */
export async function loadProspectUsage(db: SupabaseClient): Promise<ProspectUsageRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600_000).toISOString();
  const out: ProspectUsageRow[] = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data, error } = await db.from("prospect_companies")
      .select("id, name, status, score, updated_at, jev_tokens, text_source, extra_sources")
      .gte("updated_at", since)
      .or("jev_tokens.gt.0,text_source.in.(linkedin,social)")
      .order("updated_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as ProspectUsageRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

export const jevUsd = (tokens: number) => (tokens / 1_000_000) * JEV_USD_PER_MTOK;

export const tavilyCallsOf = (r: ProspectUsageRow) => ({
  linkedin: r.text_source === "linkedin" || r.text_source === "social" ? 1 : 0, // Tavily extract
  search: (r.extra_sources ?? []).includes("tavily_search") ? 1 : 0,             // Tavily web search
});

/** Day / week / month / 90-day windows plus the 14-day chart, for any per-row amount. */
export function windows<T extends { updated_at: string }>(rows: T[], amount: (r: T) => number) {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const w = { today: 0, week: 0, month: 0, allTime: 0 };
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const a = amount(r);
    w.allTime += a;
    if (r.updated_at >= startOfToday) w.today += a;
    if (r.updated_at >= startOfWeek) w.week += a;
    if (r.updated_at >= startOfMonth) w.month += a;
    const k = r.updated_at.slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + a);
  }
  const daily: { date: string; value: number }[] = [];
  for (let i = DAILY_CHART_DAYS - 1; i >= 0; i--) {
    const k = new Date(now.getTime() - i * 24 * 3600_000).toISOString().slice(0, 10);
    daily.push({ date: k, value: byDay.get(k) ?? 0 });
  }
  return { ...w, daily };
}
