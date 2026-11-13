import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { issuesFromLogs, issuesFromMailboxes } from "@/lib/services/service-health";
import { listInstantlyAccounts, type InstantlyAccount } from "@/lib/services/instantly";

export const maxDuration = 60;

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

// Instantly is one workspace shared by every company, so one mailbox list
// serves all callers. ponytail: per-instance cache, a cold instance just asks again.
const MAILBOX_TTL_MS = 5 * 60_000;
let mailboxCache: { at: number; accounts: InstantlyAccount[] } | null = null;
async function instantlyMailboxes(): Promise<InstantlyAccount[]> {
  if (!mailboxCache || Date.now() - mailboxCache.at > MAILBOX_TTL_MS) {
    mailboxCache = { at: Date.now(), accounts: await listInstantlyAccounts() };
  }
  return mailboxCache.accounts;
}

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: rows } = await db
    .from("enrichment_logs")
    .select("source, event, error, payload, created_at")
    .gte("created_at", since)
    .neq("event", "ROUTE_TIMING") // timing rows must not push real issues out of the 500
    .order("created_at", { ascending: false })
    .limit(500);

  return ok({ issues: [...issuesFromLogs(rows ?? []), ...(await mailboxIssues(db))] });
}

/** Broken Instantly mailboxes that this company's live campaigns send from.
 *  An Instantly outage must not take the rest of the banner down with it. */
async function mailboxIssues(db: ReturnType<typeof dbForUser>) {
  try {
    const { data: live } = await db.from("campaigns").select("id").eq("status", "active").eq("is_deleted", false);
    const ids = (live ?? []).map((c) => c.id as string);
    if (ids.length === 0) return [];
    const { data: subs } = await db.from("instantly_campaigns").select("email_list, sender_email").in("campaign_id", ids);
    const inUse = new Set<string>();
    for (const s of subs ?? []) {
      for (const e of [...((s.email_list as string[] | null) ?? []), s.sender_email as string | null]) {
        for (const one of (e ?? "").split(",")) if (one.trim()) inUse.add(one.trim().toLowerCase());
      }
    }
    return issuesFromMailboxes(await instantlyMailboxes(), inUse);
  } catch {
    return [];
  }
}
