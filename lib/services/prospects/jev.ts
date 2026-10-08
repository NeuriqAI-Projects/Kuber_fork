// Jev (TypeSafe) scores a company from its text. Jev answers typed questions
// and never writes prose, so the one-line reason is assembled here from its
// answers. Price: $0.042 per 1M input tokens, output free
// (https://docs.typesafe.ai/models). API: https://docs.typesafe.ai/api
import type { FitScoring } from "./fit-rules";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_USD_PER_MTOK = 0.042;

export interface JevScore {
  score: number;        // 1..10
  confidence: number;   // 0..1, Jev's own
  reason: string;       // "converter · film_extrusion · agriculture · size medium"
  model: string;
  input_tokens: number;
  answers: Record<string, unknown>;
}

export function buildQuestions(cfg: FitScoring) {
  return {
    fit: {
      type: "score",
      instructions: `${cfg.ideal_customer} How good a customer is this company for them? Judge only from the text.`,
      criteria: cfg.levels,
    },
    business: { type: "choice", instructions: "What does this company mainly do?", criteria: {
      converter: "Makes products by processing plastic: film, bags, packaging, moulded parts, pipes, profiles, sheets, bottles",
      plastic_trader: "Sells or distributes plastic, resin or polymer but does not process it",
      masterbatch_maker: "Makes masterbatch, colours, compounds or additives for plastics",
      other_manufacturer: "Manufactures mainly with other materials: metal, paper, textile, food, chemicals",
      non_manufacturer: "Does not manufacture: services, retail, trading of non-plastic goods, publishing",
      unclear: "The text does not say what the company does" } },
    process: { type: "choice", instructions: "Which plastic process does the company use?", criteria: {
      film_extrusion: "Blown or cast film, bags, flexible packaging", injection_moulding: "Injection moulding",
      blow_moulding: "Blow moulding: bottles, containers", pipe_profile_sheet: "Extrusion of pipes, profiles or sheets",
      thermoforming: "Thermoforming", compounding: "Compounding or masterbatch", other_plastic: "Another plastic process",
      not_stated: "No plastic process is stated" } },
    application: { type: "choice", instructions: "Which market do the company's products mainly serve?", criteria: {
      food_packaging: "Food and beverage packaging", other_packaging: "Other packaging", agriculture: "Agriculture",
      automotive: "Automotive", construction: "Construction and building", medical: "Medical and pharma",
      consumer_goods: "Household and consumer goods", industrial: "Industrial", other: "Something else", not_stated: "Not stated" } },
    size: { type: "choice", instructions: "How big is the company, based only on what the text says?", criteria: {
      large: "Large or multinational: several plants or countries, big numbers", medium: "Medium: one or two plants, regional",
      small: "Small or local workshop", not_stated: "The text gives no clue about size" } },
  };
}

type Answers = Record<string, { score?: number; confidence?: number; choice?: string }>;

/** Throws on any answer shape we don't recognise, so a bad reply is retried, never stored. */
export function parseJevResponse(j: unknown): JevScore {
  const r = j as { model?: string; answers?: Answers; usage?: { input_tokens?: number } };
  const a = r?.answers;
  const raw = a?.fit?.score;
  if (!a || typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 9) {
    throw new Error("JEV_BAD_RESPONSE: missing or out-of-range fit score");
  }
  const pick = (k: string) => (typeof a[k]?.choice === "string" ? a[k].choice : "unknown");
  return {
    score: Math.round(raw) + 1, // Jev levels are 0-based
    confidence: typeof a.fit.confidence === "number" ? a.fit.confidence : 0,
    reason: `${pick("business")} · ${pick("process")} · ${pick("application")} · size ${pick("size")}`,
    model: r.model ?? "unknown",
    input_tokens: r.usage?.input_tokens ?? 0,
    answers: a,
  };
}

export async function jevScore(secret: string, cfg: FitScoring, name: string, text: string): Promise<JevScore> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    // 12k chars keeps well inside Jev's 32k-token state budget.
    body: JSON.stringify({ model: "jev-latest", state: { company_name: name, website_text: text.slice(0, 12000) }, questions: buildQuestions(cfg) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Object.assign(new Error(`JEV_HTTP_${res.status}`), { status: res.status });
  return parseJevResponse(await res.json());
}
