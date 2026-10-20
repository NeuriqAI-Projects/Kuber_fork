import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { callerFromRequest } from "@/lib/services/assistant/caller";
import { executeAction } from "@/lib/services/assistant/actions";

export const maxDuration = 60;

const ExecuteSchema = z.object({ token: z.string().min(20).max(60_000) });

/** POST /api/v1/assistant/actions — run an action the user just confirmed on an assistant card. */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const parsed = ExecuteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Actions need a signed-in user");

  try {
    return ok(await executeAction(caller, parsed.data.token));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
