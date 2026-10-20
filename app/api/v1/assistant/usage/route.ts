import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { loadTeam, readAllPages } from "@/lib/services/assistant/tools/shared";

type UsageRow = {
  user_id?: string | null; provider: string; model: string; purpose: string; cost_usd: number | string | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  error: string | null; created_at: string;
};

/**
 * GET /api/v1/assistant/usage?days=30 — AI spend for the AI tab: who used the
 * assistant and how much, plus every purpose (drafts, follow-ups, replies…).
 * `per_person_available` is false until llm_usage has its user_id column.
 */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  if (!user.companyId) return fail(403, "FORBIDDEN", "Company users only");
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = dbForUser(user);

  let perPerson = true;
  let rows: UsageRow[];
  try {
    rows = (await readAllPages<UsageRow>((from, to) =>
      db.from("llm_usage")
        .select("user_id, provider, model, purpose, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error, created_at")
        .gte("created_at", since).order("created_at", { ascending: false }).range(from, to), 100_000)).rows;
  } catch {
    // user_id column not there yet (migration not run) — everything else still works.
    perPerson = false;
    rows = (await readAllPages<UsageRow>((from, to) =>
      db.from("llm_usage")
        .select("provider, model, purpose, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error, created_at")
        .gte("created_at", since).order("created_at", { ascending: false }).range(from, to), 100_000)).rows;
  }

  const team = await loadTeam(db);
  const names = new Map(team.map((t) => [t.id, t]));
  const tokens = (r: UsageRow) => (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0) + (r.output_tokens ?? 0);
  const cost = (r: UsageRow) => Number(r.cost_usd ?? 0);
  const round = (n: number) => Math.round(n * 10_000) / 10_000;

  type Agg = { calls: number; cost_usd: number; tokens: number; failed: number; unpriced: number; last_used: string | null };
  const blank = (): Agg => ({ calls: 0, cost_usd: 0, tokens: 0, failed: 0, unpriced: 0, last_used: null });
  const add = (a: Agg, r: UsageRow) => {
    a.calls++; a.cost_usd += cost(r); a.tokens += tokens(r);
    if (r.error) a.failed++;
    if (!r.error && r.cost_usd == null) a.unpriced++;
    if (!a.last_used || r.created_at > a.last_used) a.last_used = r.created_at;
  };

  const total = blank();
  const byPurpose = new Map<string, Agg>();
  const byPerson = new Map<string, Agg>();
  const byModel = new Map<string, Agg>();
  const daily = new Map<string, { assistant: number; other: number }>();
  for (const r of rows) {
    add(total, r);
    const purpose = r.purpose ?? "other";
    if (!byPurpose.has(purpose)) byPurpose.set(purpose, blank());
    add(byPurpose.get(purpose)!, r);
    const model = `${r.provider}/${r.model}`;
    if (!byModel.has(model)) byModel.set(model, blank());
    add(byModel.get(model)!, r);
    if (purpose === "assistant") {
      const who = r.user_id ?? "unknown";
      if (!byPerson.has(who)) byPerson.set(who, blank());
      add(byPerson.get(who)!, r);
    }
    const day = r.created_at.slice(0, 10);
    const d = daily.get(day) ?? { assistant: 0, other: 0 };
    if (purpose === "assistant") d.assistant += cost(r); else d.other += cost(r);
    daily.set(day, d);
  }
  const finish = (a: Agg) => ({ ...a, cost_usd: round(a.cost_usd) });

  const dayList: Array<{ date: string; assistant: number; other: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const d = daily.get(date) ?? { assistant: 0, other: 0 };
    dayList.push({ date, assistant: round(d.assistant), other: round(d.other) });
  }

  return ok({
    window_days: days,
    per_person_available: perPerson,
    total: finish(total),
    by_purpose: [...byPurpose.entries()].map(([purpose, a]) => ({ purpose, ...finish(a) })).sort((a, b) => b.cost_usd - a.cost_usd),
    by_person: [...byPerson.entries()].map(([id, a]) => ({
      user_id: id === "unknown" ? null : id,
      name: id === "unknown" ? "Before tracking" : names.get(id)?.name ?? "Former teammate",
      email: names.get(id)?.email ?? null,
      role: names.get(id)?.role ?? null,
      ...finish(a),
    })).sort((a, b) => b.cost_usd - a.cost_usd),
    by_model: [...byModel.entries()].map(([model, a]) => ({ model, ...finish(a) })).sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 12),
    daily: dayList,
  });
}
