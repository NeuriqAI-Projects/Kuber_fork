// How Jev's two answers become a decision. Stored per company in
// `settings.fit_scoring` so the cut-offs can be tuned from the client's
// Approve/Reject clicks; these defaults come from the 8–9 Oct 2026 tests.

export interface FitScoring {
  /** P(plastic maker) at or above this → good fit. */
  yes_min: number;
  /** P(plastic maker) at or below this → hidden. In between = unsure. */
  no_max: number;
  /** Cap on automatic reveals per search, so one search can't drain Apollo. */
  max_auto_reveals_per_search: number;
}

export const DEFAULT_FIT_SCORING: FitScoring = { yes_min: 0.65, no_max: 0.35, max_auto_reveals_per_search: 20 };

export type Verdict = "good" | "hidden" | "unsure";

export function verdict(plastic: number, cfg: FitScoring): Verdict {
  if (plastic >= cfg.yes_min) return "good";
  if (plastic <= cfg.no_max) return "hidden";
  return "unsure";
}

/** The 1–10 number shown in the list: 9 = makes the searched products, 7 = other plastic products, 2 = not a fit. */
export function displayScore(plastic: number, onTarget: number, cfg: FitScoring): number | null {
  const v = verdict(plastic, cfg);
  if (v === "hidden") return 2;
  if (v === "unsure") return null;
  return onTarget >= cfg.yes_min ? 9 : 7;
}

/** One plain line for the list, built in code (Jev never writes text). */
export function reasonFor(plastic: number, onTarget: number, cfg: FitScoring): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const v = verdict(plastic, cfg);
  if (v === "hidden") return `Not a plastic maker (${pct(plastic)})`;
  if (v === "unsure") return `Unclear if it makes plastic (${pct(plastic)})`;
  return onTarget >= cfg.yes_min
    ? `Makes plastic products (${pct(plastic)}) · matches the searched products (${pct(onTarget)})`
    : `Makes plastic products (${pct(plastic)}) · other products than searched (${pct(onTarget)})`;
}

/** Merge a stored (possibly partial or malformed) setting over the defaults. */
export function parseFitScoring(raw: unknown): FitScoring {
  let v: Partial<FitScoring> = {};
  try { v = (typeof raw === "string" ? JSON.parse(raw) : raw) ?? {}; } catch { v = {}; }
  const prob = (x: unknown, d: number) => (typeof x === "number" && x >= 0 && x <= 1 ? x : d);
  const yes = prob(v.yes_min, DEFAULT_FIT_SCORING.yes_min);
  const no = prob(v.no_max, DEFAULT_FIT_SCORING.no_max);
  const cap = v.max_auto_reveals_per_search;
  return {
    yes_min: yes > no ? yes : DEFAULT_FIT_SCORING.yes_min,
    no_max: yes > no ? no : DEFAULT_FIT_SCORING.no_max,
    max_auto_reveals_per_search: typeof cap === "number" && cap >= 0 ? cap : DEFAULT_FIT_SCORING.max_auto_reveals_per_search,
  };
}
