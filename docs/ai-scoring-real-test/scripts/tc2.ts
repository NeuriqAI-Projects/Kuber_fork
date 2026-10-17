// TC-1 + TC-2 (reduced to the user's 50-credit cap). PAID: 1 Apollo credit per page that has results.
import fs from "node:fs";
import { CLIENT, OUT, APOLLO_HARD_STOP, ledger, spent, sleep, services } from "./lib";
const SELECT = ["K05","K01","K03","K08","K17","K18","K10","K11","K14","K19","K20","K38","K40","K22","K23","K47","K61","K25","K26","K27","K28","K29","K30","K31","K32","K36","K56","K59"];
(async () => {
  const kws = JSON.parse(fs.readFileSync(OUT + "keywords.json", "utf8")) as { id: string; word: string; groups: string[] }[];
  const { searchOrganizations } = await import("../../../lib/services/apollo");
  const { normalizeDomain } = await import("../../../lib/utils/domain");
  const { db, apolloBalance } = await services();
  fs.mkdirSync(OUT + "tc2", { recursive: true });
  const summaryPath = OUT + "tc2-summary.csv";
  if (!fs.existsSync(summaryPath)) fs.writeFileSync(summaryPath, "id,word,groups,total_entries,pages,returned,known_orgs,known_prospects,new,with_website,linkedin_only,credits_charged,examples\n");
  const done = new Set(fs.readdirSync(OUT + "tc2").map((f) => f.replace(".json", "")));
  let bal = await apolloBalance();
  console.log("start balance", bal, "ledger spent", spent("apollo"));
  let sinceCheck = 0;
  for (const id of SELECT) {
    if (done.has(id)) continue;
    const k = kws.find((x) => x.id === id)!;
    if (spent("apollo") + 1 > APOLLO_HARD_STOP) { console.log("HARD STOP reached"); break; }
    let res;
    try {
      res = await searchOrganizations({ page: 1, advanced: { keywordTags: [k.word] } });
    } catch (e) {
      ledger("TC-2", "apollo", "search_error", `${id} ${k.word}: ${(e as Error).message.slice(0, 120)}`, 0, bal, "");
      console.error("APOLLO ERROR - stopping, no retry:", id, (e as Error).message.slice(0, 200)); process.exit(2);
    }
    const orgs = res.organizations;
    const total = res.pagination.total_entries;
    const ids = orgs.map((o) => o.id);
    const dom = (u: string | null) => { if (!u) return null; try { return normalizeDomain(u); } catch { return u.toLowerCase(); } };
    const domains = orgs.map((o) => dom(o.primary_domain)).filter(Boolean) as string[];
    const [a, b, c] = await Promise.all([
      ids.length ? db.from("organizations").select("apollo_org_id").in("apollo_org_id", ids) : { data: [] },
      domains.length ? db.from("organizations").select("domain").in("domain", domains) : { data: [] },
      ids.length ? db.from("prospect_companies").select("apollo_org_id").in("apollo_org_id", ids) : { data: [] },
    ]);
    const kId = new Set((a.data ?? []).map((r: any) => r.apollo_org_id)); const kDom = new Set((b.data ?? []).map((r: any) => String(r.domain).toLowerCase()));
    const kPros = new Set((c.data ?? []).map((r: any) => r.apollo_org_id));
    const isKnown = (o: any) => kId.has(o.id) || (dom(o.primary_domain) && kDom.has(dom(o.primary_domain)!));
    const known = orgs.filter(isKnown).length; const knownPros = orgs.filter((o) => !isKnown(o) && kPros.has(o.id)).length;
    const withSite = orgs.filter((o) => o.website_url || o.primary_domain).length;
    const liOnly = orgs.filter((o) => !o.website_url && !o.primary_domain && o.linkedin_url).length;
    const charged = orgs.length > 0 ? 1 : 0;
    fs.writeFileSync(OUT + `tc2/${id}.json`, JSON.stringify({ id, word: k.word, total_entries: total, returned: orgs.length, orgs: orgs.map((o) => ({ id: o.id, name: o.name, primary_domain: o.primary_domain, website_url: o.website_url, linkedin_url: o.linkedin_url, twitter_url: o.twitter_url, facebook_url: o.facebook_url, known: isKnown(o) })) }, null, 1));
    const ex = orgs.slice(0, 10).map((o) => o.name).join(" | ").replace(/"/g, "'");
    fs.appendFileSync(summaryPath, [id, k.word, `"${k.groups.join("; ")}"`, total, Math.ceil(total / 100), orgs.length, known, knownPros, orgs.length - known - knownPros, withSite, liOnly, charged, `"${ex}"`].join(",") + "\n");
    sinceCheck += charged;
    const doCheck = spent("apollo") === 0 || sinceCheck >= 7 || orgs.length === 0;
    let after: number | null = null;
    if (doCheck) { after = await apolloBalance(); }
    ledger("TC-2", "apollo", "org_search", `${id} ${k.word} total=${total} returned=${orgs.length}`, charged, doCheck ? bal : "", doCheck ? after : "");
    console.log(id, k.word.padEnd(32), "total", String(total).padStart(7), "returned", orgs.length, "known", known, doCheck ? `balance ${bal}->${after}` : "");
    if (doCheck) { bal = after; sinceCheck = 0; }
    await sleep(1000);
  }
  console.log("done. ledger apollo spent:", spent("apollo"), "balance", await apolloBalance());
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
