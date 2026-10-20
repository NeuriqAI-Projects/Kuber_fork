import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { callerFromRequest } from "@/lib/services/assistant/caller";
import { overviewTools } from "@/lib/services/assistant/tools/overview";

/**
 * GET /api/v1/assistant/overview — the Home tab's "at a glance" numbers. The same
 * pipeline_overview tool the assistant uses, run directly: no AI call, no cost,
 * and the employee scope applies exactly as it does in chat.
 */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  try {
    const execute = overviewTools(caller).pipeline_overview.execute as unknown as (input: object, opts: object) => Promise<unknown>;
    return ok(await execute({}, { toolCallId: "home-overview", messages: [] }));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
