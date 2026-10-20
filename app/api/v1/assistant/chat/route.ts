import { NextRequest, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/api-auth";
import { fail } from "@/lib/api-response";
import { callerDisplayName, callerFromRequest } from "@/lib/services/assistant/caller";
import { streamAssistant, type AssistantUIMessage } from "@/lib/services/assistant/agent";

// Deep mode can run ~15 tool steps on a strong model.
export const maxDuration = 300;

const ChatSchema = z.object({
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant", "system"]), parts: z.array(z.unknown()) }).passthrough()).min(1).max(400),
  mode: z.enum(["fast", "deep"]).default("fast"),
  thread_id: z.string().uuid().nullable().optional(),
});

/** POST /api/v1/assistant/chat — one streamed assistant turn (AI SDK UI message stream). */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const parsed = ChatSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const caller = callerFromRequest(req, user);
  if (!caller) return fail(403, "FORBIDDEN", "The assistant works for signed-in users only");

  // The browser may only send user/assistant turns; system text is server-side only.
  const messages = (parsed.data.messages as unknown as AssistantUIMessage[]).filter((m) => m.role !== "system");
  if (messages[messages.length - 1]?.role !== "user") {
    return fail(400, "VALIDATION_ERROR", "The last message must be from the user");
  }

  try {
    return await streamAssistant({
      caller,
      userName: await callerDisplayName(caller),
      messages,
      mode: parsed.data.mode,
      threadId: parsed.data.thread_id ?? null,
      abortSignal: req.signal,
      runAfter: (fn) => after(fn),
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/No AI provider is configured/i.test(msg)) return fail(503, "NO_AI_KEY", "No AI key is set up. A manager can add one in Credits > AI.");
    return fail(500, "INTERNAL", msg);
  }
}
