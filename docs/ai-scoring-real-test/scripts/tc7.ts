// TC-7: free People Search for every AI-good company (TC-6 + TC-4). NO reveal. Balance must not move.
import fs from "node:fs";
import { OUT, ledger, sleep, services, saveApolloAny } from "./lib";
(async () => {
  const { searchPeople } = await import("../../../lib/services/apollo");
  const { pickBestContact } = await import("../../../lib/services/lead-ranking");
  const { apolloBalance } = await services();
  const good = [...JSON.parse(fs.readFileSync(OUT + "tc6-merged.json", "utf8")), ...JSON.parse(fs.readFileSync(OUT + "tc4-merged.json", "utf8"))].filter((x: any) => x.status === "good");
  const seen = new Set<string>(); const list = good.filter((x: any) => (seen.has(x.apollo_id) ? false : (seen.add(x.apollo_id), true)));
  console.log("good companies (distinct):", list.length);
  const before = await apolloBalance(); console.log("balance before", before);
  const out: any[] = [];
  for (const c of list) {
    const request = { organizationIds: [c.apollo_id], page: 1 };
    let res: any;
    try { res = await searchPeople(request); }
    catch (e) { console.error("PEOPLE SEARCH ERROR - stop:", (e as Error).message.slice(0, 200)); break; }
    const file = saveApolloAny(`people_${c.apollo_id}`, request, res);   // everything saved first
    const people = res.people ?? [];
    const emailable = people.filter((p: any) => p.has_email);
    const best = pickBestContact(emailable);
    out.push({ apollo_id: c.apollo_id, name: c.name, label: c.plastic_label, people: people.length, emailable: emailable.length, best_title: best?.title ?? null, best_first_name: best?.first_name ?? null, raw_file: file });
    process.stdout.write(`${c.name.slice(0, 30).padEnd(30)} people=${String(people.length).padStart(3)} emailable=${String(emailable.length).padStart(3)} best=${best?.title ?? "-"}\n`);
    await sleep(1200);
  }
  const after = await apolloBalance();
  fs.writeFileSync(OUT + "tc7-contacts.json", JSON.stringify({ balance_before: before, balance_after: after, rows: out }, null, 1));
  const csv = "apollo_id,name,reviewer_label,people,emailable,best_title\n" + out.map((r) => [r.apollo_id, `"${r.name.replace(/"/g, "'")}"`, r.label, r.people, r.emailable, `"${(r.best_title ?? "").replace(/"/g, "'")}"`].join(",")).join("\n") + "\n";
  fs.writeFileSync(OUT + "tc7-contacts.csv", csv);
  ledger("TC-7", "apollo", "people_search_free", `${out.length} companies`, 0, before, after);
  console.log("done", out.length, "balance", before, "->", after, "(expected unchanged)");
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
