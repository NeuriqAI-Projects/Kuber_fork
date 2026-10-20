import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { callerFromRequest } from "@/lib/services/assistant/caller";
import { listThreads } from "@/lib/services/assistant/threads";

/** GET /api/v1/assistant/threads — the caller's saved chats, newest first. `available: false` until the migration is run. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  const threads = await listThreads(caller.db, caller.userId);
  return ok({ available: threads !== null, threads: threads ?? [] });
}
