// Jev (TypeSafe) is a classifier: it answers typed questions with
// probabilities and never writes prose (https://docs.typesafe.ai/concepts/system-one).
// We ask it two narrow yes/no questions per company and let our code decide
// (fit-rules.ts). Tested on 95 + 200 real client companies, 8–9 Oct 2026
// (Firecrawl-Test/live-100, batch-check).
// Price: $0.042 per 1M input tokens, output free (https://docs.typesafe.ai/models).
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_USD_PER_MTOK = 0.042;

export interface SearchedFor {
  /** Batch / segment name, e.g. "Film and Extrusion". */
  segment?: string | null;
  /** The keyword labels the search was run with, e.g. ["Blown Film", "Shrink Film"]. */
  keywords: string[];
}

export interface JevVerdict {
  /** P(company runs its own plastic production, so it could buy masterbatch). Decides good/hidden. */
  plastic: number;
  /** P(it makes the products this search was for). Priority only. */
  on_target: number;
  model: string;
  input_tokens: number;
  answers: Record<string, unknown>;
}

/** Both questions in one request: Jev reads the page once, so the second costs only its own few tokens. */
export const QUESTIONS = {
  plastic_maker: {
    type: "noul",
    instructions: { question: "The company in `company` itself manufactures plastic products or plastic materials of any kind, according to `website_text`." },
    criteria: {
      true: { what: "Runs its own plastic production: film, bags, sacks, bottles, containers, caps, moulded parts, pipes, sheets, tanks, foam, cables, compounds, recycled granules." },
      false: {
        what: "Does not run its own plastic production.",
        examples: [
          "Only trades, resells or distributes plastic or packaging",
          "Makes masterbatch or colourants itself (a competitor)",
          "Makes machines, moulds or equipment for plastic processors",
          "Only uses plastic packaging for its own goods, e.g. a food, cosmetics or pharma brand",
          "Makes products mainly from metal, paper, glass, wood or textile",
        ],
      },
    },
  },
  on_target: {
    type: "noul",
    instructions: { question: "The company in `company` itself manufactures products matching `searched_for.keywords`, according to `website_text`." },
    criteria: {
      true: { what: "It makes these products in its own factory." },
      false: { what: "It does not make these products itself: it makes other products, only uses or sells them, or makes the machines for them." },
    },
  },
} as const;

/** Throws on any answer shape we don't recognise, so a bad reply is retried, never stored. */
export function parseJevResponse(j: unknown): JevVerdict {
  const r = j as { model?: string; answers?: Record<string, { noul?: unknown }>; usage?: { input_tokens?: number } };
  const p = r?.answers?.plastic_maker?.noul, t = r?.answers?.on_target?.noul;
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (!ok(p) || !ok(t)) throw new Error("JEV_BAD_RESPONSE: missing or out-of-range answer");
  return { plastic: p, on_target: t, model: r.model ?? "unknown", input_tokens: r.usage?.input_tokens ?? 0, answers: r.answers as Record<string, unknown> };
}

export async function jevCheck(secret: string, company: { name: string; website: string | null }, searchedFor: SearchedFor, text: string): Promise<JevVerdict> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    // 8k chars of cleaned text: Jev's docs warn that unrelated text lowers accuracy.
    body: JSON.stringify({ model: "jev-latest", state: { company, searched_for: searchedFor, website_text: text.slice(0, 8000) }, questions: QUESTIONS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw Object.assign(new Error(`JEV_HTTP_${res.status}`), { status: res.status });
  return parseJevResponse(await res.json());
}
