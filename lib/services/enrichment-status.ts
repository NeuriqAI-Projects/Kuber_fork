import { isProviderOutage } from "./provider-errors";

/**
 * Enrichment failures that retrying can never fix.
 *
 * There is no website, no contactable person, the domain does not resolve, or
 * the page loaded and had nothing on it. None of that changes because we ask
 * again — and each of these has already been through the fallback that tries to
 * infer a domain from the leads' own email addresses, so the cheap options are
 * exhausted before an org can land here.
 *
 * Lives here rather than in either route because BOTH retry paths have to agree
 * on it, and they did not. The automatic cron (auto-retry-failed-orgs) already
 * excluded NO_DOMAIN and NO_EMAILED_LEADS; "Retry all" did not, and all 427
 * NO_DOMAIN organisations sat at attempts=1, so every press requeued the lot to
 * fail again immediately. Churn that achieved nothing, and it made the Input
 * Required count look actionable when most of it was not.
 *
 * An org whose DATA later improves is still picked up: auto-retry-failed-orgs
 * requeues a failed org once it has a usable lead, which is the only signal
 * that actually changes the answer.
 *
 * That claim was WRONG when first written here on 30 Aug 2026. The route
 * existed, but nothing scheduled it — not vercel.json, not pg_cron, and no
 * caller anywhere — so the safety net had never run once. It is now a pg_cron
 * job (`auto-retry-failed-orgs`, every 6 hours). Recorded because the mistake
 * is easy to repeat: a route existing is not the same as a route running.
 */
export const TERMINAL_ENRICHMENT_STATUSES = [
  "NO_DOMAIN",
  "NO_EMAILED_LEADS",
  "SCRAPE_DOMAIN_UNREACHABLE",
  "SCRAPE_EMPTY",
] as const;

/** PostgREST `not.in` list form, e.g. `("NO_DOMAIN","NO_EMAILED_LEADS")`. */
export const TERMINAL_STATUS_LIST = `(${TERMINAL_ENRICHMENT_STATUSES.map((s) => `"${s}"`).join(",")})`;

/**
 * The status an LLM extraction failure gets.
 *
 * An AI key that is missing, empty or rate-limited is OUR problem, exactly like a
 * missing Firecrawl key, so it gets the same no-strike status and is requeued.
 * Before 16 Sep 2026 it counted against the company: 106 organisations were
 * written off with "No LLM provider configured" and never read by any model.
 * Reusing SCRAPE_PROVIDER_UNAVAILABLE (rather than a new status) is deliberate -
 * markFailed, "Retry all" and the recovery watchdog already treat it correctly.
 */
export function llmFailureStatus(errorMessage: string): "SCRAPE_PROVIDER_UNAVAILABLE" | "LLM_EXTRACTION_FAILED" {
  return isProviderOutage(errorMessage) ? "SCRAPE_PROVIDER_UNAVAILABLE" : "LLM_EXTRACTION_FAILED";
}

/** How long an org may sit queued, with nothing stopping it, before it is
 *  concluded as ENRICHMENT_NEVER_RAN. */
export const ABANDONED_QUEUE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the "queued for over 24h" write-off may run.
 *
 * That rule exists for a crashed worker chain. But the credit gate ALSO leaves
 * orgs queued - on purpose - while a provider is out of money, and the write-off
 * could not tell the two apart. When credits came back after a multi-day outage,
 * the first batch wrote off every org that had waited over a day instead of
 * enriching it: 2,030 client organisations, Sep 2026.
 *
 * So the clock only counts time with no credit wait: if the gate skipped a batch
 * within the window, the queue was held, not abandoned.
 */
export function mayConcludeAbandonedQueue(lastCreditWaitAt: string | null, now = Date.now()): boolean {
  if (!lastCreditWaitAt) return true;
  return now - new Date(lastCreditWaitAt).getTime() > ABANDONED_QUEUE_MS;
}
