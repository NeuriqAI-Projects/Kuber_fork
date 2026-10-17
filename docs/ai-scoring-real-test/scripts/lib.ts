import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
export const CLIENT = "00000000-0000-0000-0000-00000000000b";
export const OUT = "docs/ai-scoring-real-test/data/";
export const APOLLO_HARD_STOP = 48;     // user approved 50; stop with 2 spare
export const LEDGER = OUT + "ledger.csv";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ledger(test: string, service: string, action: string, detail: string, credits: number, before: unknown, after: unknown) {
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, "time_iso,test,service,action,detail,credits_expected,balance_before,balance_after\n");
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  fs.appendFileSync(LEDGER, [new Date().toISOString(), test, service, action, esc(detail), credits, before ?? "", after ?? ""].join(",") + "\n");
}
/** Credits we have spent so far, from our own ledger (source of truth). */
export function spent(service: string): number {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, "utf8").split("\n").slice(1).filter(Boolean).reduce((n, l) => {
    const m = l.match(/^[^,]*,[^,]*,([^,]*),.*,(\d+),[^,]*,[^,]*$/);
    return m && m[1] === service ? n + Number(m[2]) : n;
  }, 0);
}
export async function services() {
  const { createAdminClient } = await import("../../../lib/supabase/admin");
  const { createScopedClient } = await import("../../../lib/supabase/scoped");
  const credits = await import("../../../lib/services/provider-credits");
  const admin = createAdminClient();
  const db = createScopedClient(CLIENT);
  const apolloBalance = async () => (await credits.checkApolloCredits(admin, "any", { fresh: true })).remaining as number | null;
  const firecrawlBalance = async () => (await credits.checkFirecrawlCredits(admin, CLIENT, { fresh: true })).remaining as number | null;
  return { admin, db, apolloBalance, firecrawlBalance };
}

/** Save EVERYTHING a paid Apollo call returned (the request, the pagination, every company with Apollo's full `raw` object). */
export function saveApollo(label: string, request: unknown, result: { organizations: unknown[]; pagination: unknown }) {
  fs.mkdirSync(OUT + "apollo-raw", { recursive: true });
  const n = fs.readdirSync(OUT + "apollo-raw").length + 1;
  const file = `${OUT}apollo-raw/${String(n).padStart(3, "0")}-${label.replace(/[^A-Za-z0-9_-]+/g, "_")}.json`;
  fs.writeFileSync(file, JSON.stringify({ saved_at: new Date().toISOString(), label, request, pagination: result.pagination, count: result.organizations.length, organizations: result.organizations }, null, 1));
  return file;
}

/** Same idea for any Apollo response shape (people search etc.): save the whole thing. */
export function saveApolloAny(label: string, request: unknown, response: unknown) {
  fs.mkdirSync(OUT + "apollo-raw", { recursive: true });
  const n = fs.readdirSync(OUT + "apollo-raw").length + 1;
  const file = `${OUT}apollo-raw/${String(n).padStart(3, "0")}-${label.replace(/[^A-Za-z0-9_-]+/g, "_")}.json`;
  fs.writeFileSync(file, JSON.stringify({ saved_at: new Date().toISOString(), label, request, response }, null, 1));
  return file;
}
