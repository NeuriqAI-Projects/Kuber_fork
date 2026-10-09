/**
 * Jev fit test, step 2 (real Jev): send each org's raw Firecrawl markdown to
 * TypeSafe's Jev model (POST https://api.typesafe.ai/v1/systemone) and record
 * its typed answers.
 *
 * Jev is a "System One" model: it takes a `state` string plus typed questions
 * (choice / score / noul) and returns answers with probabilities and a
 * confidence. It does not write reasoning or quotes, so the fit judgment is
 * expressed as one Score question plus several yes/no (noul) questions.
 *
 *   node --env-file=.env.jev.local --env-file=.env.local scripts/jev-score-api.mjs [limit] [raw|clean] [rich]
 *
 * rich  adds Kuber Polyplast's full stored company profile and product list
 *       (settings: company_context, product_offerings) to the fit, competitor
 *       and colour questions. Needs the Supabase vars from .env.local.
 *
 * raw   reads docs/jev-fit-test/firecrawl-raw-100.json   (markdown exactly as stored)
 * clean reads docs/jev-fit-test/firecrawl-clean-100.json (images, URLs, duplicates stripped)
 * Writes docs/jev-fit-test/jev-api-scores-<n>[-clean].json
 */
import { readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing — run with --env-file=.env.jev.local");

const URL = "https://api.typesafe.ai/v1/systemone";
const LIMIT = Number(process.argv[2] ?? 100);
const VARIANT = process.argv[3] === "clean" ? "clean" : "raw";
const INPUT = `docs/jev-fit-test/firecrawl-${VARIANT}-100.json`;
const MD = VARIANT === "clean" ? "clean_markdown" : "raw_markdown";
const RICH = process.argv[4] === "rich";
const CONCURRENCY = 5;
/** Same cap on every run, so runs differ only in the variable under test. */
const MARKDOWN_CAP = 15_000;

const SELLER =
  "Kuber Polyplast sells masterbatch (colour, black, white, additive, filler) and engineering compounds to plastics PROCESSORS: companies that melt and shape polymer into goods (film extrusion, blown/cast film, injection/blow moulding, rotomoulding, sheet, pipe and profile extrusion, woven sacks, bottles, closures, packaging).";

const questions = {
  fit: {
    type: "score",
    instructions: `${SELLER} How good a fit is the company described in the state as a recurring BUYER of that masterbatch?`,
    criteria: [
      "Not a fit: not in plastics at all, or a direct competitor that makes masterbatch or compounds for sale, or a pure raw-material or resin supplier, or a consultancy, or content unrelated to the company.",
      "Weak: mostly trading, distribution or reselling; or tooling, machinery or equipment; or a business where plastic is incidental.",
      "Plausible: plastics-adjacent or mixed business, or a processor with thin evidence. Worth a look but not a priority.",
      "Good: a plastics processor or converter with real production of its own, in a niche or with some uncertainty about colour or additive use.",
      "Excellent: a clear plastics processor in film, packaging, pipes, moulding or woven sacks with real production of its own, a near-certain recurring masterbatch buyer.",
    ],
  },
  business_type: {
    type: "choice",
    instructions: "What kind of business is the company in the state? Judge only from the content.",
    criteria: {
      processor: "Manufactures plastic products or film by processing polymer itself: extrusion, moulding, thermoforming, weaving of plastic tape",
      trader: "Mainly buys and resells plastic products, packaging or resin without manufacturing",
      machinery: "Makes machinery, tooling, instruments or equipment",
      competitor: "Makes masterbatch, compounds or additives for sale to plastics processors",
      other_plastics: "In plastics, but another role: recycler, resin producer, converter without extrusion, service provider",
      not_plastics: "Not a plastics business: textiles, software, logistics, metal or glass packaging, apparel, food, other",
      unclear: "The content does not say what the company does",
    },
  },
  is_processor: { type: "noul", instructions: "The company itself manufactures plastic products by melting and shaping polymer (extrusion, injection, blow or rotational moulding, thermoforming)." },
  is_competitor: { type: "noul", instructions: "The company manufactures masterbatch, colour concentrates or plastic compounds for sale to other manufacturers." },
  colour_or_additive_need: { type: "noul", instructions: "The content shows the company's plastic products are coloured, pigmented, printed-film, or need additives such as UV protection, anti-block, slip or flame retardancy." },
  page_sufficient: { type: "noul", instructions: "The content is enough for a careful person to tell what the company manufactures and whether it works with plastics." },
};

function buildState(o) {
  const a = o.apollo;
  const kw = Array.isArray(a.keywords) ? a.keywords.slice(0, 25).join(", ") : "";
  return `Company name: ${o.name}
Website: ${o.domain ?? "unknown"}
Apollo listing - industry: ${a.industry ?? "n/a"} | employees: ${a.employees ?? "n/a"} | location: ${[a.city, a.country].filter(Boolean).join(", ") || "n/a"}
Apollo keywords: ${kw || "n/a"}

WEBSITE CONTENT (Firecrawl markdown${o.markdown_chars > MARKDOWN_CAP ? `, first ${MARKDOWN_CAP.toLocaleString()} of ${o.markdown_chars.toLocaleString()} chars` : ""}):
${o[MD].slice(0, MARKDOWN_CAP)}`;
}

async function callJev(state) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions }),
    });
    if (res.ok) return { body: await res.json(), latency_ms: Date.now() - t0 };
    // 429 / 529 are transient; anything else is ours to fix, so fail loudly.
    if ((res.status === 429 || res.status === 529) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

if (RICH) {
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const KUBER_POLYPLAST = "00000000-0000-0000-0000-00000000000b";
  const { data, error } = await db.from("settings").select("key,value").eq("company_id", KUBER_POLYPLAST).in("key", ["company_context", "product_offerings"]);
  if (error) throw error;
  const companyContext = String(data.find((d) => d.key === "company_context").value).trim();
  const products = JSON.parse(data.find((d) => d.key === "product_offerings").value);
  // The stored "COLOR MASTERBATCH" description is a copy of the additive masterbatch text,
  // so the colour range is described from the company profile instead.
  const COLOUR = "COLOUR MASTERBATCH\nRoHS and REACH compliant, heavy-metal-free colour masterbatch with pearlescent, marble and fluorescent effects, and a 0.2% micro-granule dosage option. Used to colour film, packaging, moulded parts, pipes and woven sacks.";
  const productText = products.map((p) => (/^colou?r masterbatch$/i.test(p.name) ? COLOUR : `${p.name.toUpperCase()}\n${p.description.trim()}`)).join("\n\n");
  const CONTEXT = `ABOUT THE SELLER, KUBER POLYPLAST\n${companyContext}\n\nWHO BUYS FROM KUBER\n${SELLER}\n\nKUBER'S PRODUCTS\n${productText}`;
  writeFileSync("docs/jev-fit-test/kuber-context-used.txt", CONTEXT);
  console.log(`Kuber context added: ${CONTEXT.length.toLocaleString()} chars`);
  for (const q of ["fit", "is_competitor", "colour_or_additive_need"]) questions[q].instructions = `${CONTEXT}\n\nQUESTION\n${questions[q].instructions}`;
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
      model = body.model;
      inTok += body.usage?.input_tokens ?? 0;
      outTok += body.usage?.output_tokens ?? 0;
      results[i] = { org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars, latency_ms, answers: body.answers, usage: body.usage };
    } catch (err) {
      failed++;
      results[i] = { org_id: o.org_id, name: o.name, domain: o.domain, markdown_chars: o.markdown_chars, error: err.message };
    }
    done++;
    if (done % 10 === 0 || done === orgs.length) console.log(`  ${done}/${orgs.length} (${failed} failed)`);
  }
}

console.log(`Jev (${VARIANT} input${RICH ? ", rich Kuber context" : ""}): scoring ${orgs.length} orgs, concurrency ${CONCURRENCY}`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const out = `docs/jev-fit-test/jev-api-scores-${orgs.length}${VARIANT === "clean" ? "-clean" : ""}${RICH ? "-rich" : ""}.json`;
writeFileSync(out, JSON.stringify({
  scored_at: new Date().toISOString(), model, markdown_cap: MARKDOWN_CAP, questions,
  totals: { scored: orgs.length - failed, failed, input_tokens: inTok, output_tokens: outTok, est_cost_usd: (inTok / 1e6) * 0.042 },
  results,
}, null, 2));
console.log(`Saved -> ${out} | model ${model} | tokens in ${inTok.toLocaleString()} out ${outTok.toLocaleString()} | failed ${failed}`);
