import { after, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Real run times of the credit-spending routes, so their time limits can be set
 * from data instead of guesses. One enrichment_logs row per run, event
 * ROUTE_TIMING, payload { route, ms, status, ...counts }. Never throws: a
 * logging failure must not touch the route.
 */
export async function writeRouteTiming(
  route: string,
  ms: number,
  companyId: string | null | undefined,
  counts: Record<string, unknown> = {},
): Promise<void> {
  try {
    await createAdminClient().from("enrichment_logs").insert({
      source: "system",
      event: "ROUTE_TIMING",
      company_id: companyId ?? null,
      duration_ms: ms,
      payload: { route, ms, ...counts },
    });
  } catch { /* timing is best-effort */ }
}

/** Numbers and flags from an ok()/fail() body: the cheap "what did this run do" counts. */
export function countsFromBody(body: unknown): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  const b = body as { data?: unknown; error?: { code?: unknown } | null } | null;
  if (b?.data && typeof b.data === "object") {
    for (const [k, v] of Object.entries(b.data)) {
      if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
  }
  if (typeof b?.error?.code === "string") out.error_code = b.error.code;
  return out;
}

export type RouteTiming = { companyId?: string | null };

/**
 * Wraps a POST handler: times it and writes the row in after(), so the user
 * never waits for it. The handler sets `timing.companyId` once it knows the
 * company. 401/403 answers are not logged (anyone can hit a URL).
 */
export function withRouteTiming(
  route: string,
  handler: (req: NextRequest, timing: RouteTiming) => Promise<Response>,
) {
  return async (req: NextRequest): Promise<Response> => {
    const startedAt = Date.now();
    const timing: RouteTiming = {};
    let res: Response | undefined;
    try {
      res = await handler(req, timing);
      return res;
    } finally {
      const ms = Date.now() - startedAt;
      const status = res?.status ?? 500;
      if (status !== 401 && status !== 403) {
        const copy = res?.clone();
        after(async () => {
          const body = copy ? await copy.json().catch(() => null) : null;
          await writeRouteTiming(route, ms, timing.companyId, { status, ...(res ? {} : { threw: true }), ...countsFromBody(body) });
        });
      }
    }
  };
}
