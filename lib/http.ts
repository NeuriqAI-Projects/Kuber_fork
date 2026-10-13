const TIMEOUTS: Record<string, number> = {
  apollo: 30_000,
  firecrawl: 60_000,
  llm: 90_000,
};

const RETRY_DELAYS = [1_000, 3_000, 9_000];

/**
 * Retry schedule per service. Apollo gets NONE — deliberately.
 *
 * Apollo bills a credit the moment a people/bulk_match request is *received*,
 * including requests it then rejects with 429 and requests we abandon on
 * timeout. Proven against the live account on 2026-07-14: 1,403 people were
 * asked for and Apollo charged 3,222 credits — 2.30x — because this helper
 * retried every rate-limited attempt and Apollo billed each one. Retrying a
 * billed endpoint is buying the same record twice.
 *
 * So Apollo gets exactly one attempt per request, ever. A batch that fails is
 * released back to the queue unpenalised (enrich-leads.ts) and resumed by the
 * 15-minute watchdog, which costs nothing. Firecrawl and the LLM providers
 * charge on delivery, not receipt, so retrying those is genuinely free and
 * their schedule is unchanged.
 */
const RETRY_DELAYS_BY_SERVICE: Record<string, number[]> = {
  apollo: [],
  firecrawl: RETRY_DELAYS,
  llm: RETRY_DELAYS,
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE = new Set([400, 401, 402, 403, 404, 422]);

export async function fetchWithRetry(
  service: "apollo" | "firecrawl" | "llm",
  url: string,
  init: RequestInit,
  /** Tighter limits for a caller with its own deadline (e.g. scoring's 60 s run). */
  opts?: { timeoutMs?: number; retryDelays?: number[] }
): Promise<Response> {
  const timeout = opts?.timeoutMs ?? TIMEOUTS[service];
  const retryDelays = opts?.retryDelays ?? RETRY_DELAYS_BY_SERVICE[service] ?? RETRY_DELAYS;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (NON_RETRYABLE.has(res.status)) return res;
      if (!RETRYABLE.has(res.status)) return res;

      if (attempt === retryDelays.length) return res;

      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter
        ? parseInt(retryAfter) * 1_000
        : retryDelays[attempt];
      await sleep(delay);
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retryDelays.length) throw err;
      await sleep(retryDelays[attempt]);
    }
  }

  throw new Error("fetchWithRetry: exhausted retries");
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
