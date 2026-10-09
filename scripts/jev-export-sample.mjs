/**
 * Step 1 of the Jev fit test: pull a reproducible random sample of enriched
 * organisations WITH their raw Firecrawl markdown and save it to disk, so the
 * data can be read and analysed offline.
 *
 * Read-only: SELECTs only, no LLM calls, no credits spent.
 *
 *   node --env-file=.env.local scripts/jev-export-sample.mjs [count] [seed]
 *
 * Writes docs/jev-fit-test/firecrawl-raw-<count>.json
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

const KUBER_POLYPLAST = "00000000-0000-0000-0000-00000000000b";
const COUNT = Number(process.argv[2] ?? 100);
const SEED = Number(process.argv[3] ?? 42);

// mulberry32 — tiny seeded PRNG so the same sample can be re-pulled later.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Page through ids only — the markdown column is heavy, fetch it for the sample alone.
const ids = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from("organizations")
    .select("id")
    .eq("company_id", KUBER_POLYPLAST)
    .eq("enrichment_stage", "done")
    .not("scraped_markdown", "is", null)
    .order("id")
    .range(from, from + 999);
  if (error) throw error;
  ids.push(...data.map((r) => r.id));
  if (data.length < 1000) break;
}
console.log(`Eligible enriched orgs with raw markdown: ${ids.length}`);

const rand = rng(SEED);
for (let i = ids.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [ids[i], ids[j]] = [ids[j], ids[i]];
}
const picked = ids.slice(0, COUNT);

const { data: rows, error } = await db
  .from("organizations")
  .select("id, name, domain, website, industry, keywords, employees, city, country, company_description, sells_to, scraped_at, scraped_markdown")
  .in("id", picked);
if (error) throw error;

const out = rows.map((r) => ({
  org_id: r.id,
  name: r.name,
  domain: r.domain,
  apollo: { industry: r.industry, keywords: r.keywords, employees: r.employees, city: r.city, country: r.country },
  existing_extraction: { company_description: r.company_description, sells_to: r.sells_to },
  scraped_at: r.scraped_at,
  markdown_chars: r.scraped_markdown.length,
  raw_markdown: r.scraped_markdown,
}));

mkdirSync("docs/jev-fit-test", { recursive: true });
const file = `docs/jev-fit-test/firecrawl-raw-${COUNT}.json`;
writeFileSync(file, JSON.stringify({ exported_at: new Date().toISOString(), seed: SEED, count: out.length, orgs: out }, null, 2));

const lens = out.map((o) => o.markdown_chars).sort((a, b) => a - b);
const q = (p) => lens[Math.floor((lens.length - 1) * p)];
console.log(`Saved ${out.length} orgs -> ${file}`);
console.log(`markdown chars  min ${lens[0]} · p25 ${q(0.25)} · median ${q(0.5)} · p75 ${q(0.75)} · p90 ${q(0.9)} · max ${lens.at(-1)}`);
console.log(`over 8,000 chars (the old extractor's cut-off): ${lens.filter((n) => n > 8000).length}`);
