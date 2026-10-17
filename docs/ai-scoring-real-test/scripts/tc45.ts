// TC-1 (empty page is free) + TC-4 (deeper pages) + TC-5 (country filters). PAID. Full raw response saved for every call.
import fs from "node:fs";
import { OUT, APOLLO_HARD_STOP, ledger, spent, sleep, services, saveApollo } from "./lib";
const WORD = "stretch film";
type Step = { key: string; test: string; page: number; locations?: string[]; word?: string; expectEmpty?: boolean };
const STEPS: Step[] = [
  { key: "K59-p3-empty", test: "TC-1", page: 3, word: "PP Sheets", expectEmpty: true },   // PP Sheets total 55 -> page 3 is beyond the end
  { key: "K01-p2", test: "TC-4", page: 2 }, { key: "K01-p5", test: "TC-4", page: 5 }, { key: "K01-p10", test: "TC-4", page: 10 },
  { key: "K01-India", test: "TC-5", page: 1, locations: ["India"] }, { key: "K01-UnitedStates", test: "TC-5", page: 1, locations: ["United States"] },
];
(async () => {
  const { searchOrganizations } = await import("../../../lib/services/apollo");
  const { normalizeDomain } = await import("../../../lib/utils/domain");
  const { db, apolloBalance } = await services();
  fs.mkdirSync(OUT + "tc45", { recursive: true });
  for (const s of STEPS) {
    if (fs.existsSync(OUT + `tc45/${s.key}.json`)) continue;
    if (spent("apollo") + 1 > APOLLO_HARD_STOP) { console.log("HARD STOP"); break; }
    const word = s.word ?? WORD;
    const request = { page: s.page, locations: s.locations, advanced: { keywordTags: [word] } };
    const before = await apolloBalance();
    let res; try { res = await searchOrganizations(request); }
    catch (e) { ledger(s.test, "apollo", "search_error", `${s.key}: ${(e as Error).message.slice(0, 120)}`, 0, before, ""); console.error("APOLLO ERROR - stop", (e as Error).message.slice(0, 200)); process.exit(2); }
    const rawFile = saveApollo(s.key, request, res);          // saved BEFORE anything else
    const orgs = res.organizations;
    const dom = (u: string | null) => { if (!u) return null; try { return normalizeDomain(u); } catch { return u.toLowerCase(); } };
    const ids = orgs.map((o) => o.id); const domains = orgs.map((o) => dom(o.primary_domain)).filter(Boolean) as string[];
    const [a, b] = await Promise.all([ids.length ? db.from("organizations").select("apollo_org_id").in("apollo_org_id", ids) : { data: [] }, domains.length ? db.from("organizations").select("domain").in("domain", domains) : { data: [] }]);
    const kId = new Set((a.data ?? []).map((r: any) => r.apollo_org_id)); const kDom = new Set((b.data ?? []).map((r: any) => String(r.domain).toLowerCase()));
    const isKnown = (o: any) => kId.has(o.id) || (dom(o.primary_domain) && kDom.has(dom(o.primary_domain)!));
    const after = await apolloBalance();
    const dropped = (before ?? 0) - (after ?? 0);
    fs.writeFileSync(OUT + `tc45/${s.key}.json`, JSON.stringify({ id: s.key, test: s.test, word, page: s.page, locations: s.locations ?? null, total_entries: res.pagination.total_entries, returned: orgs.length, balance_before: before, balance_after: after, balance_dropped: dropped, raw_file: rawFile, orgs: orgs.map((o) => ({ id: o.id, name: o.name, primary_domain: o.primary_domain, website_url: o.website_url, linkedin_url: o.linkedin_url, twitter_url: o.twitter_url, facebook_url: o.facebook_url, known: isKnown(o) })) }, null, 1));
    ledger(s.test, "apollo", "org_search", `${s.key} page=${s.page} loc=${(s.locations ?? []).join("/")} total=${res.pagination.total_entries} returned=${orgs.length}`, orgs.length > 0 ? 1 : 0, before, after);
    console.log(s.key.padEnd(18), "total", res.pagination.total_entries, "returned", orgs.length, "known", orgs.filter(isKnown).length, `balance ${before}->${after} (dropped ${dropped})`, s.expectEmpty ? (orgs.length === 0 ? "EMPTY as expected" : "NOT EMPTY?!") : "");
    await sleep(1000);
  }
  console.log("ledger apollo spent:", spent("apollo"));
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
