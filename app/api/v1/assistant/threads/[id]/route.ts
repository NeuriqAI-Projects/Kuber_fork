import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { callerFromRequest } from "@/lib/services/assistant/caller";
import { z } from "zod";
import type { UIMessage } from "ai";
import { deleteThread, loadThread, saveThread } from "@/lib/services/assistant/threads";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  const { id } = await params;
  const thread = await loadThread(caller.db, caller.userId, id);
  if (!thread) return fail(404, "NOT_FOUND", "Chat not found");
  return ok(thread);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  const { id } = await params;
  if (!(await deleteThread(caller.db, caller.userId, id))) return fail(500, "INTERNAL", "Could not delete the chat");
  return ok({ deleted: true });
}

const PatchSchema = z.object({
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), parts: z.array(z.unknown()) }).passthrough()).max(400),
});

/** PATCH — save the chat as the panel now shows it (e.g. after an action card was confirmed). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "Signed-in users only");
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { id } = await params;
  const saved = await saveThread(caller.db, caller.userId, id, parsed.data.messages as unknown as UIMessage[]);
  return ok({ saved });
}
