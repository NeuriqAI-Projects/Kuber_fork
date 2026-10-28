import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { issuesFromLogs } from "@/lib/services/service-health";

// Surfaces recent upstream credit/auth failures so the UI can show a clear
// "top up / fix your API key" banner instead of leaving managers to decode raw
// HTTP 402 dumps buried in a lead's enrichment log. Scans the last few hours of
// enrichment_logs for the signatures of the three paid providers.
//
// Deliberately looks at the NEWEST log row per provider, not "any error in the
// window" — an old 402 sitting in the last 6h must not keep the banner up
// after the key's been fixed and later scrapes are succeeding again. Rows with
// error: null (successes) are included in the query for exactly this reason:
// they're what lets a fixed key "win" over a stale error.
const LOOKBACK_HOURS = 6;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: rows } = await db
    .from("enrichment_logs")
    .select("source, event, error, payload, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  return ok({ issues: issuesFromLogs(rows ?? []) });
}
