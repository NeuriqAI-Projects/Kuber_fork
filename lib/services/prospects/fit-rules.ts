// The client's fit rules and what each score leads to. Stored per company in
// `settings.fit_scoring` so the client can edit them; DEFAULT_FIT_SCORING is
// Kuber's first draft (1 Oct 2026), used until the client sends their own.

export interface FitScoring {
  /** Score at or above this reveals one email automatically. */
  auto_reveal_min: number;
  /** Score at or above this (and below auto) waits for the client to decide. Below it is hidden. */
  review_min: number;
  /** Cap on automatic reveals per search, so one search can't drain Apollo. */
  max_auto_reveals_per_search: number;
  /** Who the client sells to, in one sentence. Goes into every scoring question. */
  ideal_customer: string;
  /** Exactly 10 levels, score 1 first. Jev picks one. */
  levels: string[];
}

export const DEFAULT_FIT_SCORING: FitScoring = {
  auto_reveal_min: 7,
  review_min: 4,
  max_auto_reveals_per_search: 20,
  ideal_customer:
    "Kuber Polyplast sells colour, white, black and additive masterbatch to companies that process plastic themselves (film, bags, packaging, moulded parts, pipes, sheets, bottles).",
  levels: [
    "Not a manufacturer: services, retail, publisher, software, food or pharma trading",
    "Manufacturer that does not process plastic (metal, paper, textile, food, cosmetics)",
    "Trades or distributes plastics or resins, or makes masterbatch or colours itself (a competitor); does not convert plastic",
    "Uses plastic parts in its products but buys them in; plastic processing is not its own process",
    "The text does not make clear whether the company processes plastic",
    "Processes some plastic, but plastic is a small side activity",
    "Plastic converter of modest size or narrow range",
    "Plastic converter clearly making coloured or additive-containing plastic products",
    "Sizeable plastic converter (film, bags, packaging, moulded parts, pipes, sheets) with clear colour or additive needs",
    "Large or multi-site plastic converter with high-volume colour, white, black or additive use",
  ],
};

export type Bucket = "good" | "review" | "hidden";

export function bucketFor(score: number, cfg: FitScoring): Bucket {
  if (score >= cfg.auto_reveal_min) return "good";
  if (score >= cfg.review_min) return "review";
  return "hidden";
}

/** "AI unsure" band: worth spending a free/cheap extra lookup before deciding. */
export const isUnsure = (score: number, cfg: FitScoring): boolean => bucketFor(score, cfg) === "review";

/** Merge a stored (possibly partial or malformed) setting over the defaults. */
export function parseFitScoring(raw: unknown): FitScoring {
  let v: Partial<FitScoring> = {};
  try { v = (typeof raw === "string" ? JSON.parse(raw) : raw) ?? {}; } catch { v = {}; }
  const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const levels = Array.isArray(v.levels) && v.levels.length === 10 && v.levels.every((l) => typeof l === "string" && l.trim())
    ? v.levels : DEFAULT_FIT_SCORING.levels;
  return {
    auto_reveal_min: num(v.auto_reveal_min, DEFAULT_FIT_SCORING.auto_reveal_min),
    review_min: num(v.review_min, DEFAULT_FIT_SCORING.review_min),
    max_auto_reveals_per_search: num(v.max_auto_reveals_per_search, DEFAULT_FIT_SCORING.max_auto_reveals_per_search),
    ideal_customer: typeof v.ideal_customer === "string" && v.ideal_customer.trim() ? v.ideal_customer : DEFAULT_FIT_SCORING.ideal_customer,
    levels,
  };
}
