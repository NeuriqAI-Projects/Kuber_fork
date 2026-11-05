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

/** A provider's Retry-After is honoured up to this long. Longer waits outlast
 *  every route's 55-60 s budget; giving up hands the call to the next key/tier. */
const MAX_RETRY_AFTER_MS = 5_000;

/** LLM calls start no NEW attempt this long after the first one began, so
 *  complete() can still fail over inside the route budget. An attempt already
 *  in flight is never cut short (it may be about to deliver a paid answer). */
const LLM_RETRY_WINDOW_MS = 40_000;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE = new Set([400, 401, 402, 403, 404, 422]);

export async function fetchWithRetry(
  service: "apollo" | "firecrawl" | "llm",
  url: string,
  init: RequestInit,
  /** Tighter limits for a caller with its own deadline (e.g. scoring's 60 s run).
   *  `deadline` (epoch ms): no retry STARTS after it; LLM calls default to 40 s. */
  opts?: { timeoutMs?: number; retryDelays?: number[]; deadline?: number }
): Promise<Response> {
  const timeout = opts?.timeoutMs ?? TIMEOUTS[service];
  const retryDelays = opts?.retryDelays ?? RETRY_DELAYS_BY_SERVICE[service] ?? RETRY_DELAYS;
  const deadline = opts?.deadline ?? (service === "llm" ? Date.now() + LLM_RETRY_WINDOW_MS : Infinity);

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      // The caller's own signal (e.g. a closed request) cancels too, not only the timeout.
      const res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
      clearTimeout(timer);

      if (NON_RETRYABLE.has(res.status)) return res;
      if (!RETRYABLE.has(res.status)) return res;

      if (attempt === retryDelays.length) return res;

      const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "");
      const delay = Number.isFinite(retryAfterSec)
        ? Math.min(retryAfterSec * 1_000, MAX_RETRY_AFTER_MS)
        : retryDelays[attempt];
      if (Date.now() + delay > deadline) return res;
      await sleep(delay);
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retryDelays.length || init.signal?.aborted) throw err;
      if (Date.now() + retryDelays[attempt] > deadline) throw err;
      await sleep(retryDelays[attempt]);
    }
  }

  throw new Error("fetchWithRetry: exhausted retries");
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
