// The assistant's agent loop: one streamed answer, with as many tool calls as
// the question needs (bounded per mode), on whichever provider the company's
// try-order serves.
import {
  convertToModelMessages, createIdGenerator, createUIMessageStreamResponse, generateText, isStepCount, streamText, toUIMessageStream,
  type UIMessage,
} from "ai";

/** Server-made ids for assistant messages, so a saved chat never holds an empty id. */
const messageId = createIdGenerator({ prefix: "msg", size: 16 });
import type { AssistantCaller } from "@/lib/services/assistant/context";
import { buildProviderChain } from "@/lib/services/assistant/provider-chain";
import { buildAssistantTools } from "@/lib/services/assistant/tools";
import { ASSISTANT_STATIC_PROMPT, assistantDynamicPrompt } from "@/lib/services/assistant/prompt";
import { recordAssistantUsage, toTokenUsage } from "@/lib/services/assistant/usage";
import { costOf } from "@/lib/services/llm-pricing";
import { fallbackTitle, renameThread, saveThread } from "@/lib/services/assistant/threads";
import type { AssistantMode } from "@/lib/services/assistant/models";
import type { LlmProviderId } from "@/lib/services/providers/registry";

/** Bounds per mode: steps = model turns (each may run several tools in parallel). */
// Fast mode turns thinking off: picking a tool and phrasing a short answer does
// not need it, and on every model measured it was most of the time to first word.
const LIMITS: Record<AssistantMode, { steps: number; maxOutputTokens: number; reasoning: "none" | "high" }> = {
  fast: { steps: 8, maxOutputTokens: 6_000, reasoning: "none" },
  deep: { steps: 18, maxOutputTokens: 24_000, reasoning: "high" },
};

/** Sent with every assistant message so the UI can show model, time and cost. */
export type AssistantMessageMetadata = {
  mode?: AssistantMode;
  model?: string;
  provider?: string;
  startedAt?: number;
  durationMs?: number;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
};

export type AssistantUIMessage = UIMessage<AssistantMessageMetadata>;

/**
 * What happened to the confirm cards in this chat. A card is confirmed AFTER
 * the assistant's own text ("press Confirm…"), so in the transcript the result
 * sits before words that say it is still waiting — and the model believed the
 * words. Stating outcomes in the instructions every turn removes the doubt.
 */
export function actionOutcomes(messages: AssistantUIMessage[]): string | null {
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (!p.type.startsWith("tool-propose_")) continue;
      const out = (p as unknown as { output?: { proposal?: { title?: string }; executed?: { ok: boolean; message: string; link?: string }; cancelled?: boolean } }).output;
      if (!out?.proposal) continue;
      const title = out.proposal.title ?? "Action";
      if (out.executed) {
        lines.push(`- ${title}: ${out.executed.ok ? "DONE" : "FAILED"} — ${out.executed.message}${out.executed.link ? ` (${out.executed.link})` : ""}`);
      } else if (out.cancelled) {
        lines.push(`- ${title}: CANCELLED by the user.`);
      } else {
        lines.push(`- ${title}: still waiting for the user to confirm.`);
      }
    }
  }
  return lines.length ? `Confirm cards in this chat, oldest first. This is the current truth, newer than anything said earlier:\n${lines.join("\n")}` : null;
}

export async function streamAssistant(opts: {
  caller: AssistantCaller;
  userName: string;
  messages: AssistantUIMessage[];
  mode: AssistantMode;
  threadId: string | null;
  abortSignal?: AbortSignal;
  /** Runs after the response is sent (Next.js `after`), so title generation never delays the answer. */
  runAfter?: (fn: () => Promise<void>) => void;
  /** Evals only: pin one provider (and optionally a model) instead of the company's try-order. */
  pin?: { provider: LlmProviderId; model?: string };
}): Promise<Response> {
  const { caller, mode, threadId } = opts;
  const limits = LIMITS[mode];
  const chain = await buildProviderChain(caller.db, caller.companyId, mode, opts.pin);
  const tools = buildAssistantTools(caller);
  const startedAt = Date.now();

  const result = streamText({
    model: chain.model,
    instructions: [
      // Fixed text first and marked for caching (Anthropic; other providers cache
      // automatically or ignore the hint). The per-request block comes after it.
      { role: "system", content: ASSISTANT_STATIC_PROMPT, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "system", content: [assistantDynamicPrompt({ mode, userName: opts.userName, role: caller.role }), actionOutcomes(opts.messages)].filter(Boolean).join("\n\n") },
    ],
    messages: await convertToModelMessages(opts.messages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: isStepCount(limits.steps),
    reasoning: limits.reasoning,
    maxOutputTokens: limits.maxOutputTokens,
    abortSignal: opts.abortSignal,
    onEnd: async ({ usage }) => {
      const served = chain.servedBy();
      for (const f of chain.failures()) {
        await recordAssistantUsage(caller.db, {
          companyId: caller.companyId, userId: caller.userId, provider: f.provider, model: f.model, tier: f.tier,
          usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0, error: f.error,
        });
      }
      if (!served) return;
      await recordAssistantUsage(caller.db, {
        companyId: caller.companyId, userId: caller.userId, provider: served.provider, model: served.model, tier: served.tier,
        usage: toTokenUsage(usage), durationMs: Date.now() - startedAt, error: null,
      });
    },
  });

  const stream = toUIMessageStream<typeof tools, AssistantUIMessage>({
    stream: result.stream,
    tools,
    originalMessages: opts.messages,
    generateMessageId: messageId,
    sendReasoning: false,
    messageMetadata: ({ part }) => {
      if (part.type === "start") return { mode, startedAt };
      if (part.type === "finish") {
        const served = chain.servedBy();
        const tokens = toTokenUsage(part.totalUsage);
        return {
          mode, startedAt,
          durationMs: Date.now() - startedAt,
          model: served?.model, provider: served?.provider,
          costUsd: served ? costOf(served.model, tokens, served.provider) : null,
          inputTokens: tokens.inputTokens + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0),
          outputTokens: tokens.outputTokens,
        };
      }
      return undefined;
    },
    onError: (error) => {
      const msg = (error as Error)?.message ?? String(error);
      if (/No AI provider is configured/i.test(msg)) return "No AI key is set up. A manager can add one in Credits > AI.";
      if (/Every AI provider failed/i.test(msg)) return "The AI provider is not answering right now. Please try again in a minute.";
      return "Something went wrong while answering. Please try again.";
    },
    onEnd: async ({ messages, isAborted }) => {
      if (!threadId || isAborted) return;
      const isFirstTurn = messages.filter((m) => m.role === "user").length === 1;
      const saved = await saveThread(caller.db, caller.userId, threadId, messages, isFirstTurn ? fallbackTitle(messages) : undefined);
      if (saved && isFirstTurn && opts.runAfter) {
        opts.runAfter(() => nameThread(caller, threadId, messages));
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** A 3–6 word chat title from the cheapest model — the "utility" role. Failure keeps the fallback title. */
async function nameThread(caller: AssistantCaller, threadId: string, messages: AssistantUIMessage[]): Promise<void> {
  try {
    const question = fallbackTitle(messages);
    const chain = await buildProviderChain(caller.db, caller.companyId, "utility");
    const startedAt = Date.now();
    const { text, usage } = await generateText({
      model: chain.model,
      instructions: "Write a 3 to 6 word title for a chat that starts with this question. Plain words, no quotes, no punctuation at the end.",
      prompt: question,
      maxOutputTokens: 400,
      reasoning: "none",
    });
    const title = text.replace(/["'`*#]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (title) await renameThread(caller.db, caller.userId, threadId, title);
    const served = chain.servedBy();
    if (served) {
      await recordAssistantUsage(caller.db, {
        companyId: caller.companyId, userId: caller.userId, provider: served.provider, model: served.model, tier: served.tier,
        usage: toTokenUsage(usage), durationMs: Date.now() - startedAt, error: null,
      });
    }
  } catch { /* the fallback title stays */ }
}
