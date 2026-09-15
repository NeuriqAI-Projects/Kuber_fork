/**
 * One-off repair for organisations written off by OUR outages, not their own
 * websites (the two gaps fixed on 16 Sep 2026):
 *
 *  - ENRICHMENT_NEVER_RAN: queued while the credit gate held the queue, then
 *    concluded by the 24h rule the moment credits returned.
 *  - ENRICHMENT_FAILED_PERMANENT whose last error was a provider fault (no key,
 *    no credits, rate limit): strikes spent on requests that never reached a model
 *    or a website.
 *
 * Each is set to failed / SCRAPE_PROVIDER_UNAVAILABLE with its attempt count left
 * alone. That is the status the recovery watchdog already requeues every 10
 * minutes once the company's Firecrawl key is usable - so --apply STARTS SPENDING
 * Firecrawl and AI credits within minutes. Dead websites, empty pages and missing
 * domains are not touched.
 *
 * Dry run by default.
 *   npx tsx --env-file=.env.vercel scripts/repair-stuck-enrichment.ts [--company=<uuid>] [--apply]
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { isProviderOutage } from "@/lib/services/provider-errors";

const APPLY = process.argv.includes("--apply");
const COMPANY = process.argv.find((a) => a.startsWith("--company="))?.split("=")[1];
const NAMES: Record<string, string> = { "00000000-0000-0000-0000-00000000000a": "Dev", "00000000-0000-0000-0000-00000000000b": "Kuber Polyplast" };

/** Firecrawl-side faults, as scrape-orgs' isProviderFault reads them. */
const firecrawlFault = (e: string) => /No usable Firecrawl key configured|API key not configured|payment required|insufficient credits/i.test(e);

async function main() {
  const db = createAdminClient();
  const rows: Array<{ id: string; company_id: string; enrichment_status: string; last_error: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("organizations").select("id, company_id, enrichment_status, last_error")
      .eq("enrichment_stage", "failed").in("enrichment_status", ["ENRICHMENT_NEVER_RAN", "ENRICHMENT_FAILED_PERMANENT"])
      .order("id").range(from, from + 999);
    if (COMPANY) q = q.eq("company_id", COMPANY);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const fix = rows.filter((o) => o.enrichment_status === "ENRICHMENT_NEVER_RAN"
    || firecrawlFault(o.last_error ?? "") || isProviderOutage(o.last_error ?? ""));
  const summary: Record<string, number> = {};
  for (const o of fix) {
    const why = o.enrichment_status === "ENRICHMENT_NEVER_RAN" ? "never ran (waited on credits)" : (o.last_error ?? "").slice(0, 45);
    const k = `${NAMES[o.company_id] ?? o.company_id} | ${why}`;
    summary[k] = (summary[k] ?? 0) + 1;
  }
  console.log(`checked ${rows.length} written-off organisations; ${fix.length} were our outage:`);
  Object.entries(summary).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  console.log(`left alone (their own website/data): ${rows.length - fix.length}`);

  if (!APPLY) { console.log("\nDRY RUN - nothing changed. --apply hands these to the recovery watchdog, which starts spending credits."); return; }
  let done = 0;
  for (let i = 0; i < fix.length; i += 200) {
    const ids = fix.slice(i, i + 200).map((o) => o.id);
    const { error } = await db.from("organizations").update({
      enrichment_status: "SCRAPE_PROVIDER_UNAVAILABLE", updated_at: new Date().toISOString(),
    }).in("id", ids);
    if (!error) done += ids.length;
  }
  console.log(`\nAPPLIED: ${done}/${fix.length} handed to the recovery watchdog.`);
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
