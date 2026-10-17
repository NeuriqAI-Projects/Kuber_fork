// Read-only preflight. Run from Kuber/:  npx tsx docs/ai-scoring-real-test/scripts/recon.ts
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const CLIENT = "00000000-0000-0000-0000-00000000000b";
(async () => {
  const { createAdminClient } = await import("../../../lib/supabase/admin");
  const { checkApolloCredits, checkFirecrawlCredits, checkTavilyCredits } = await import("../../../lib/services/provider-credits");
  const { getServiceSecret } = await import("../../../lib/services/service-keys");
  const admin = createAdminClient();
  const a = await checkApolloCredits(admin, "any", { fresh: true });
  const f = await checkFirecrawlCredits(admin, CLIENT, { fresh: true });
  const t = await checkTavilyCredits(admin, CLIENT, { fresh: true });
  console.log("apollo", JSON.stringify(a)); console.log("firecrawl", JSON.stringify(f)); console.log("tavily", JSON.stringify(t));
  for (const p of ["jev", "tavily", "apollo", "firecrawl"] as const) console.log("key present:", p, !!(await getServiceSecret(p, CLIENT)));
  const { data: keys } = await admin.from("provider_keys").select("provider,status,company_id").eq("provider", "firecrawl");
  console.log("firecrawl key rows:", JSON.stringify(keys));
  const { data: s } = await admin.from("settings").select("value").eq("company_id", CLIENT).eq("key", "industry_keyword_groups").maybeSingle();
  let groups: unknown[] = []; try { groups = JSON.parse(s?.value ?? "[]"); } catch {}
  console.log("keyword groups:", groups.length);
  fs.writeFileSync("docs/ai-scoring-real-test/data/keyword-groups-raw.json", s?.value ?? "[]");
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
