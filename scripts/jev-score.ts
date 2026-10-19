/**
 * Step 2 of the Jev fit test: hand each org's RAW Firecrawl markdown to the
 * "Jev" scorer (an LLM judge) and record a 1-10 fit score for Kuber Polyplast.
 *
 * Spends LLM credits on the Kuber Polyplast company's configured provider
 * (about 100 calls of ~4k input tokens). Writes nothing to the database apart
 * from the usual llm_usage cost row that complete() records.
 *
 *   npx tsx --env-file=.env.local scripts/jev-score.ts [input.json] [output.json]
 *
 * The prompt asks Jev for more than a number: a confidence, an explicit
 * "was the page enough to judge?" flag and a list of what was missing. That is
 * what lets the analysis say whether the raw context can scale, not just how
 * many companies scored high.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { complete } from "@/lib/services/llm";

const KUBER_POLYPLAST = "00000000-0000-0000-0000-00000000000b";
const INPUT = process.argv[2] ?? "docs/jev-fit-test/firecrawl-raw-100.json";
const OUTPUT = process.argv[3] ?? "docs/jev-fit-test/jev-scores-100.json";
const CONCURRENCY = 5;
/** Raw pages run to 167k chars; ~15k keeps the homepage body and drops footer sprawl. */
const MARKDOWN_CAP = 15_000;

interface JevVerdict {
  score: number;
  confidence: "low" | "medium" | "high";
  context_sufficient: boolean;
  business_type: string;
  what_they_make: string | null;
  uses_masterbatch: "yes" | "likely" | "unlikely" | "no" | "unknown";
  best_product: string | null;
  reasons: string[];
  red_flags: string[];
  missing_info: string[];
  evidence: string[];
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function loadSetting(key: string): Promise<string> {
  const { data, error } = await db.from("settings").select("value").eq("key", key).eq("company_id", KUBER_POLYPLAST).single();
  if (error) throw error;
  return String(data.value);
}

function systemPrompt(companyContext: string, products: string): string {
  return `You are Jev, a sales-qualification analyst for Kuber Polyplast. You read a prospect's raw website content and judge how good a fit that company is as a BUYER of Kuber's products.

ABOUT KUBER POLYPLAST (the seller):
${companyContext}

PRODUCT NAMES: ${products}

Kuber sells masterbatch (colour, black, white, additive, filler) and engineering compounds to plastics PROCESSORS — companies that melt and shape polymer into finished goods or semi-finished forms (film extrusion, blown/cast film, injection moulding, blow moulding, rotomoulding, sheet, pipe & profile extrusion, woven sacks/tapes, bottles, closures, crates, packaging, appliance parts and so on). Those companies consume masterbatch every day.

SCORING (integer 1-10):
 9-10  Clear plastics processor in Kuber's core applications (film, packaging, pipes, moulding, sacks) with real production of its own — near-certain recurring masterbatch buyer.
 7-8   Plastics processor / converter, strong signals, but a niche or some uncertainty about volume or colour/additive use.
 5-6   Plausible: plastics-adjacent or mixed business, or a processor with thin evidence. Worth a look, not a priority.
 3-4   Weak: mostly trading/distribution, packaging reseller, tooling/machinery, or a business where plastic is incidental.
 1-2   No fit: not plastics at all, a direct competitor (makes masterbatch/compounds for sale), a pure raw-material supplier, a consultancy, or content unrelated to the company.

RULES:
- Judge ONLY from the provided content. Never invent facts. A claim must be supported by something on the page.
- A trader, distributor, dealer or reseller of plastic products or resin is NOT a processor unless the page shows they manufacture.
- A masterbatch/compound manufacturer is a competitor, not a customer.
- If the page is thin, generic, a cookie wall, a login page, a parked domain, in an unreadable state or about something else entirely, say so: set context_sufficient=false and keep confidence low. Do NOT guess a high or low score to cover for missing evidence.
- context_sufficient means: could a careful human decide the fit from THIS content alone? It is about the content, not about whether the company is a good fit.

Return ONLY valid JSON, no markdown fences, exactly this shape:
{
  "score": integer 1-10,
  "confidence": "low" | "medium" | "high",
  "context_sufficient": boolean,
  "business_type": short label, e.g. "film extruder", "injection moulder", "plastic trader", "machinery maker", "masterbatch competitor", "not plastics", "unclear",
  "what_they_make": one sentence, or null if the page does not say,
  "uses_masterbatch": "yes" | "likely" | "unlikely" | "no" | "unknown",
  "best_product": the single best Kuber product name for them, or null,
  "reasons": up to 3 short strings explaining the score,
  "red_flags": up to 3 short strings (What we did in the code
No application code was changed for this test. Everything lives in docs/ai-scoring-real-test/, and the only edit outside it is excluding docs from tsconfig.json so these scripts are not type-checked with the app. The scripts call the real services directly and write only to files.

File	What it does	Cost
scripts/lib.ts	Shared helpers: loads .env.local, the Apollo hard stop (48), the ledger, balances, and saveApollo which writes each full Apollo response to disk.	free
scripts/recon.ts	Preflight: Apollo, Firecrawl and Tavily balances, key presence, keyword settings.	free
scripts/tc2.ts	One Apollo company search per keyword; counts known/new companies.	1 Apollo credit each
scripts/tc3.ts	One search per keyword group (all words together).	1 each
scripts/tc45.ts	Empty-page test, pages 2/5/10, country filters. Saves the full response.	1 each (0 for empty)
scripts/tc6.ts	Scores real companies with the real pipeline (runBatch, production settings) and an in-memory store. Reveal functions are made to throw.	Firecrawl 1 per site
scripts/tc4score.ts	Same scoring for the deeper pages.	Firecrawl 1 per site
scripts/tc7.ts	Free People Search for every good company. No reveal.	free
scripts/build_report.py	Builds report-data.js for this page from the data files.	free
Data files are in data/. Raw Apollo payloads (company lists and People Search results) and full website texts are kept locally on the tester's machine and are not in git: this repository is public and the data is paid or personal. Re-run the scripts to regenerate them.

How to re-run
cd Kuber
npx tsx docs/ai-scoring-real-test/scripts/recon.ts      # free
npx tsx docs/ai-scoring-real-test/scripts/tc2.ts        # paid, edit the SELECT list first
npx tsx docs/ai-scoring-real-test/scripts/tc6.ts        # Firecrawl credits
python3 docs/ai-scoring-real-test/scripts/build_report.py
Limits of this test
Sample sizes are small: 4 to 5 companies per keyword, 129 in total. The overall precision has a 95% range of about 80.7% to 96.1%.
One reviewer, and an AI. Labels came from page excerpts, not from opening each website.
Scope: 28 keywords (every keyword group covered), 4 keyword groups, and the India and United States filters.
The test used the code on the dev branch from 16 Oct.
Companies the client already had were skipped, as in production. The share of new companies depends on today's database.empty array if none),
  "missing_info": up to 3 short strings naming what the page did NOT tell you that you needed (empty array if nothing),
  "evidence": up to 2 short VERBATIM quotes (under 200 chars each) copied from the page that most support your score
}`;
}

interface OrgIn {
  org_id: string;
  name: string;
  domain: string | null;
  apollo: { industry: string | null; keywords: string[] | null; employees: number | null; city: string | null; country: string | null };
  markdown_chars: number;
  raw_markdown: string;
}

function userPrompt(o: OrgIn): string {
  const a = o.apollo;
  const kw = Array.isArray(a.keywords) ? a.keywords.slice(0, 25).join(", ") : "";
  return `Company name: ${o.name}
Website: ${o.domain ?? "unknown"}
Apollo listing — industry: ${a.industry ?? "n/a"} | employees: ${a.employees ?? "n/a"} | location: ${[a.city, a.country].filter(Boolean).join(", ") || "n/a"}
Apollo keywords: ${kw || "n/a"}

RAW WEBSITE CONTENT (Firecrawl markdown${o.markdown_chars > MARKDOWN_CAP ? `, first ${MARKDOWN_CAP.toLocaleString()} of ${o.markdown_chars.toLocaleString()} chars` : ""}):
${o.raw_markdown.slice(0, MARKDOWN_CAP)}`;
}

function normalise(v: Partial<JevVerdict>): JevVerdict {
  const score = Math.max(1, Math.min(10, Math.round(Number(v.score))));
  if (!Number.isFinite(score)) throw new Error(`bad score: ${JSON.stringify(v.score)}`);
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).slice(0, 3) : []);
  return {
    score,
    confidence: (["low", "medium", "high"] as const).includes(v.confidence as never) ? (v.confidence as JevVerdict["confidence"]) : "low",
    context_sufficient: v.context_sufficient === true,
    business_type: String(v.business_type ?? "unclear"),
    what_they_make: v.what_they_make ? String(v.what_they_make) : null,
    uses_masterbatch: (["yes", "likely", "unlikely", "no", "unknown"] as const).includes(v.uses_masterbatch as never) ? (v.uses_masterbatch as JevVerdict["uses_masterbatch"]) : "unknown",
    best_product: v.best_product ? String(v.best_product) : null,
    reasons: arr(v.reasons),
    red_flags: arr(v.red_flags),
    missing_info: arr(v.missing_info),
    evidence: arr(v.evidence).slice(0, 2),
  };
}

async function main() {
  const input = JSON.parse(readFileSync(INPUT, "utf8")) as { orgs: OrgIn[] };
  const [ctx, productsRaw] = await Promise.all([loadSetting("company_context"), loadSetting("product_offerings")]);
  const products = (JSON.parse(productsRaw) as Array<{ name: string }>).map((p) => p.name).join(", ");
  const system = systemPrompt(ctx, products);

  const results: Array<Record<string, unknown>> = [];
  let next = 0, done = 0, failed = 0, cost = 0, inTok = 0, outTok = 0, model = "";

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= input.orgs.length) return;
      const o = input.orgs[i];
      const t0 = Date.now();
      try {
        const res = await complete<Partial<JevVerdict>>(
          { system, user: userPrompt(o), maxTokens: 900, temperature: 0.2 },
          KUBER_POLYPLAST,
          { purpose: "other" },
        );
        const verdict = normalise(res.json);
        cost += res.costUsd ?? 0;
        inTok += res.usage?.inputTokens ?? 0;
        outTok += res.usage?.outputTokens ?? 0;
        results.push({
          org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars,
          chars_sent: Math.min(o.markdown_chars, MARKDOWN_CAP), apollo_industry: o.apollo.industry,
          ...verdict, latency_ms: Date.now() - t0, cost_usd: res.costUsd ?? null,
        });
      } catch (err) {
        failed++;
        results.push({ org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars, error: (err as Error).message.slice(0, 300) });
      }
      done++;
      if (done % 10 === 0 || done === input.orgs.length) console.log(`  ${done}/${input.orgs.length} scored (${failed} failed)`);
    }
  }

  console.log(`Scoring ${input.orgs.length} orgs, concurrency ${CONCURRENCY}`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const order = new Map(input.orgs.map((o, i) => [o.org_id, i]));
  results.sort((a, b) => (order.get(a.org_id as string) ?? 0) - (order.get(b.org_id as string) ?? 0));

  writeFileSync(OUTPUT, JSON.stringify({
    scored_at: new Date().toISOString(), markdown_cap: MARKDOWN_CAP,
    totals: { scored: results.length - failed, failed, cost_usd: cost, input_tokens: inTok, output_tokens: outTok },
    results,
  }, null, 2));
  console.log(`Saved -> ${OUTPUT}  | cost $${cost.toFixed(4)} | tokens in ${inTok.toLocaleString()} out ${outTok.toLocaleString()} | failed ${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
