/**
 * Jev fit test, simple version: give Jev Kuber Polyplast's own content and ONE
 * score question, "how good a lead is this company for Kuber Polyplast?", then
 * record its score, level probabilities and confidence for each company.
 *
 * Follows TypeSafe's guidance: background facts go in the state (as a named-field
 * object), the question only defines the judgment, and the score has a few
 * levels that each describe a concrete situation.
 *
 *   node --env-file=.env.jev.local --env-file=.env.local scripts/jev-score-simple.mjs [raw|clean] [limit]
 *
 * raw   reads docs/jev-fit-test/firecrawl-raw-100.json   (Firecrawl markdown as stored)
 * clean reads docs/jev-fit-test/firecrawl-clean-100.json (images, URLs, repeats stripped)
 * Writes docs/jev-fit-test/jev-lead-<variant>-<n>.json and kuber-content-given.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing: run with --env-file=.env.jev.local");
const VARIANT = process.argv[2] === "clean" ? "clean" : "raw";
const LIMIT = Number(process.argv[3] ?? 100);
const INPUT = `docs/jev-fit-test/firecrawl-${VARIANT}-100.json`;
const MD = VARIANT === "clean" ? "clean_markdown" : "raw_markdown";
const KUBER_POLYPLAST = "00000000-0000-0000-0000-00000000000b";
const URL = "https://api.typesafe.ai/v1/systemone";
const CONCURRENCY = 5;
const MARKDOWN_CAP = 15_000;

// Kuber's own stored content, exactly as it is in Settings: no paraphrase, no additions.
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await db.from("settings").select("key,value").eq("company_id", KUBER_POLYPLAST).in("key", ["company_context", "product_offerings"]);
if (error) throw error;
const companyContext = String(data.find((d) => d.key === "company_context").value).trim();
const products = JSON.parse(data.find((d) => d.key === "product_offerings").value);
const KUBER = `${companyContext}\n\n${products.map((p) => `${p.name.toUpperCase()}\n${p.description.trim()}`).join("\n\n")}`;
writeFileSync("docs/jev-fit-test/kuber-content-given.txt", KUBER);

const QUESTION = "How good a lead is the company for Kuber Polyplast?";
const questions = {
  lead_fit: {
    type: "score",
    instructions: "How good a lead is `company` for the business described in `about_kuber_polyplast`?",
    criteria: [
      "Not a lead: the company is not in plastics, or it makes masterbatch or compounds itself.",
      "Unlikely lead: plastics is a small or indirect part of the business, or the company only trades or distributes plastic products.",
      "Possible lead: the company works with plastics, but it is unclear whether it manufactures products itself.",
      "Good lead: the company manufactures plastic products itself, such as film, packaging, pipes or moulded parts.",
      "Strong lead: the company manufactures plastic products in volume in areas Kuber serves, such as film, packaging, pipes, woven sacks or moulded parts.",
    ],
  },
};

function buildState(o) {
  const a = o.apollo;
  return {
    about_kuber_polyplast: KUBER,
    company: {
      name: o.name,
      website: o.domain ?? "unknown",
      industry: a.industry ?? "n/a",
      employees: a.employees ?? "n/a",
      location: [a.city, a.country].filter(Boolean).join(", ") || "n/a",
      keywords: Array.isArray(a.keywords) ? a.keywords.slice(0, 25).join(", ") : "n/a",
      website_content: o[MD].slice(0, MARKDOWN_CAP),
    },
  };
}

async function callJev(state) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, model: "jev-latest", questions }) });
    if (res.ok) return { body: await res.json(), latency_ms: Date.now() - t0 };
    if ((res.status === 429 || res.status === 529) && attempt < 5) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const orgs = JSON.parse(readFileSync(INPUT, "utf8")).orgs.slice(0, LIMIT);
const results = new Array(orgs.length);
let next = 0, done = 0, failed = 0, inTok = 0, outTok = 0, model = "";
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= orgs.length) return;
    const o = orgs[i];
    try {
      const { body, latency_ms } = await callJev(buildState(o));
      model = body.model; inTok += body.usage?.input_tokens ?? 0; outTok += body.usage?.output_tokens ?? 0;
      results[i] = { org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars, latency_ms, answer: body.answers.lead_fit, usage: body.usage };
    } catch (err) { failed++; results[i] = { org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars, error: err.message }; }
    done++;
    if (done % 25 === 0 || done === orgs.length) console.log(`  ${done}/${orgs.length} (${failed} failed)`);
  }
}
console.log(`Jev lead score (${VARIANT} input): ${orgs.length} orgs`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const out = `docs/jev-fit-test/jev-lead-${VARIANT}-${orgs.length}.json`;
writeFileSync(out, JSON.stringify({ scored_at: new Date().toISOString(), model, markdown_cap: MARKDOWN_CAP, question: QUESTION, questions, totals: { scored: orgs.length - failed, failed, input_tokens: inTok, output_tokens: outTok, est_cost_usd: (inTok / 1e6) * 0.042 }, results }, null, 2));
console.log(`Saved -> ${out} | tokens in ${inTok.toLocaleString()} | failed ${failed}`);
