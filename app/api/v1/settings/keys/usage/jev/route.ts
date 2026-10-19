import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { checkJevCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";
import { jevUsd, loadProspectUsage, windows, LOOKBACK_DAYS } from "@/lib/services/prospects/usage";

// Jev (TypeSafe) has no balance or usage endpoint, only a key check. So "usage" is what this
// app recorded: every scored company stores the tokens Jev read for it.
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);

  let rows;
  try { rows = (await loadProspectUsage(db)).filter((r) => r.jev_tokens > 0); }
  catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  const key = await checkJevCredits(db, user.companyId ?? "any", { fresh: bypassCache });

  const companies = windows(rows, () => 1);
  const tokens = windows(rows, (r) => r.jev_tokens);
  const usd = windows(rows, (r) => jevUsd(r.jev_tokens));
  const decisions: Record<string, number> = {};
  for (const r of rows) decisions[r.status] = (decisions[r.status] ?? 0) + 1;

  return ok({
    key,
    companies: { today: companies.today, week: companies.week, month: companies.month, allTime: companies.allTime },
    tokens: { today: tokens.today, week: tokens.week, month: tokens.month, allTime: tokens.allTime },
    usd: { today: usd.today, week: usd.week, month: usd.month, allTime: usd.allTime },
    daily: companies.daily.map((d, i) => ({ date: d.date, companies: d.value, usd: Number(usd.daily[i].value.toFixed(5)) })),
    decisions,
    avgTokens: rows.length ? Math.round(tokens.allTime / rows.length) : 0,
    history: rows.slice(0, 200).map((r) => ({ id: r.id, created_at: r.updated_at, name: r.name, status: r.status, score: r.score, tokens: r.jev_tokens, extra: (r.extra_sources ?? []).length })),
    ledgerWindowDays: LOOKBACK_DAYS,
  });
}
