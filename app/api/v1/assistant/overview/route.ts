import { NextRequest } from "next/server";
import { requireScope, assertScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { callerFromRequest } from "@/lib/services/assistant/caller";
import { overviewTools } from "@/lib/services/assistant/tools/overview";

export const maxDuration = 60;

/**
 * GET /api/v1/assistant/overview — the Home tab's "at a glance" numbers. The same
 * pipeline_overview tool the assistant uses, run directly: no AI call, no cost,
 * and the same scopes apply as in chat: pipeline_overview needs dashboard:read,
 * and is company-wide only with dashboard:all.
 */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try {
    user = await requireScope(req, "assistant:use");
    assertScope(user, "dashboard:read");
  } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  try {
    const execute = overviewTools(caller).pipeline_overview.execute as unknown as (input: object, opts: object) => Promise<unknown>;
    return ok(await execute({}, { toolCallId: "home-overview", messages: [] }));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
