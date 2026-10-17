// TC-3 (reduced): group searches. PAID: 1 credit each.
import fs from "node:fs";
import { OUT, APOLLO_HARD_STOP, ledger, spent, sleep, services } from "./lib";
const GROUPS = ["G06", "G08", "G12", "G01"];
(async () => {
  const groups = JSON.parse(fs.readFileSync(OUT + "groups.json", "utf8")) as { id: string; group: string; words: string[] }[];
  const { searchOrganizations } = await import("../../../lib/services/apollo");
  const { normalizeDomain } = await import("../../../lib/utils/domain");
  const { db, apolloBalance } = await services();
  fs.mkdirSync(OUT + "tc3", { recursive: true });
  const sp = OUT + "tc3-summary.csv";
  if (!fs.existsSync(sp)) fs.writeFileSync(sp, "id,group,words,total_entries,returned,known_orgs,new\n");
  const have = new Set(fs.readdirSync(OUT + "tc3").map((f) => f.replace(".json", "")));
  for (const gid of GROUPS) {
    if (have.has(gid)) continue;
    const g = groups.find((x) => x.id === gid)!;
    const words = [...new Set(g.words)];
    if (spent("apollo") + 1 > APOLLO_HARD_STOP) { console.log("HARD STOP"); break; }
    const before = await apolloBalance();
    let res; try { res = await searchOrganizations({ page: 1, advanced: { keywordTags: words } }); }
    catch (e) { ledger("TC-3", "apollo", "search_error", `${gid}: ${(e as Error).message.slice(0, 120)}`, 0, before, ""); console.error("APOLLO ERROR - stop", (e as Error).message.slice(0, 200)); process.exit(2); }
    const orgs = res.organizations; const total = res.pagination.total_entries;
    const dom = (u: string | null) => { if (!u) return null; try { return normalizeDomain(u); } catch { return u.toLowerCase(); } };
    const ids = orgs.map((o) => o.id); const domains = orgs.map((o) => dom(o.primary_domain)).filter(Boolean) as string[];
    const [a, b] = await Promise.all([db.from("organizations").select("apollo_org_id").in("apollo_org_id", ids), db.from("organizations").select("domain").in("domain", domains)]);
    const kId = new Set((a.data ?? []).map((r: any) => r.apollo_org_id)); const kDom = new Set((b.data ?? []).map((r: any) => String(r.domain).toLowerCase()));
    const isKnown = (o: any) => kId.has(o.id) || (dom(o.primary_domain) && kDom.has(dom(o.primary_domain)!));
    const known = orgs.filter(isKnown).length;
    fs.writeFileSync(OUT + `tc3/${gid}.json`, JSON.stringify({ id: gid, group: g.group, words, total_entries: total, returned: orgs.length, orgs: orgs.map((o) => ({ id: o.id, name: o.name, primary_domain: o.primary_domain, website_url: o.website_url, linkedin_url: o.linkedin_url, twitter_url: o.twitter_url, facebook_url: o.facebook_url, known: isKnown(o) })) }, null, 1));
    fs.appendFileSync(sp, [gid, `"${g.group}"`, `"${words.join("; ")}"`, total, orgs.length, known, orgs.length - known].join(",") + "\n");
    const after = await apolloBalance();
    ledger("TC-3", "apollo", "group_search", `${gid} ${g.group} words=${words.length} total=${total}`, orgs.length > 0 ? 1 : 0, before, after);
    console.log(gid, g.group, `words=${words.length}`, "total", total, "returned", orgs.length, "known", known, `balance ${before}->${after}`);
    await sleep(1000);
  }
  console.log("ledger apollo spent:", spent("apollo"));
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
