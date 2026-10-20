// Kuber AI eval harness: runs one case through the real agent (same code path
// as POST /api/v1/assistant/chat, minus HTTP auth) against the live Dev company,
// and records what it did — tools, inputs, outputs, answer, timing and cost.
import { readUIMessageStream, generateText, type UIMessageChunk } from "ai";
import { createScopedClient } from "../../lib/supabase/scoped.ts";
import { streamAssistant, type AssistantUIMessage } from "../../lib/services/assistant/agent.ts";
import { buildProviderChain } from "../../lib/services/assistant/provider-chain.ts";
import type { AssistantCaller } from "../../lib/services/assistant/context.ts";
import type { LlmProviderId } from "../../lib/services/providers/registry.ts";
import { ASSISTANT_STATIC_PROMPT } from "../../lib/services/assistant/prompt.ts";

export const DEV = "00000000-0000-0000-0000-00000000000a";
type EvalUser = { id: string; name: string; role: "manager" | "employee" };

/**
 * The two people the evals act as, picked from the Dev company's team at run
 * time: a manager, and the employee with the most assigned leads (so scope
 * cases have something to see). Nothing about real people is kept in this
 * repo — it is public.
 */
export const USERS: { manager: EvalUser; employee: EvalUser } = {
  manager: { id: "", name: "", role: "manager" },
  employee: { id: "", name: "", role: "employee" },
};

export async function loadEvalUsers(): Promise<void> {
  const db = createScopedClient(DEV);
  const { data: team } = await db.from("profiles").select("id, full_name, email, role, is_active");
  const people = (team ?? []).filter((p) => p.is_active !== false);
  const name = (p: { full_name: string | null; email: string | null }) => (p.full_name || p.email || "Teammate").split(" ")[0];
  const manager = people.find((p) => p.role === "manager");
  const employees = people.filter((p) => p.role === "employee");
  if (!manager || employees.length === 0) throw new Error("The Dev company needs at least one manager and one employee for the evals.");
  const counts = await Promise.all(employees.map(async (e) => {
    const { count } = await db.from("leads").select("id", { count: "exact", head: true }).eq("assigned_to", e.id).eq("is_deleted", false);
    return { e, count: count ?? 0 };
  }));
  const employee = counts.sort((a, b) => b.count - a.count)[0].e;
  USERS.manager = { id: manager.id as string, name: name(manager as never), role: "manager" };
  USERS.employee = { id: employee.id as string, name: name(employee as never), role: "employee" };
}

export type ToolCall = { name: string; input: Record<string, unknown>; output: Record<string, unknown> | null; error: string | null };
export type TurnResult = {
  question: string;
  text: string;
  tools: ToolCall[];
  ttftMs: number | null;
  totalMs: number;
  costUsd: number | null;
  model: string | null;
  provider: string | null;
  error: string | null;
};

export function callerFor(who: keyof typeof USERS): AssistantCaller {
  const u = USERS[who];
  return { userId: u.id, role: u.role, companyId: DEV, db: createScopedClient(DEV), token: "", baseUrl: "http://localhost:3000" };
}

/** SSE body → UI message chunks. */
function chunkStream(body: ReadableStream<Uint8Array>, onChunk: (c: UIMessageChunk) => void): ReadableStream<UIMessageChunk> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  return new ReadableStream<UIMessageChunk>({
    async pull(ctrl) {
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const chunk = JSON.parse(data) as UIMessageChunk;
          onChunk(chunk);
          ctrl.enqueue(chunk);
          return;
        }
        const { value, done } = await reader.read();
        if (done) { ctrl.close(); return; }
        buf += value;
      }
    },
  });
}

/** Run a conversation (one or more user turns). Returns one result per turn. */
export async function runConversation(opts: {
  who: keyof typeof USERS;
  mode: "fast" | "deep";
  turns: string[];
  pin?: { provider: LlmProviderId; model?: string };
}): Promise<TurnResult[]> {
  const caller = callerFor(opts.who);
  let history: AssistantUIMessage[] = [];
  const results: TurnResult[] = [];

  for (const [i, question] of opts.turns.entries()) {
    history = [...history, { id: `u${i}`, role: "user", parts: [{ type: "text", text: question }] }];
    const t0 = Date.now();
    let ttft: number | null = null;
    let streamError: string | null = null;
    let final: AssistantUIMessage | null = null;
    try {
      const res = await streamAssistant({
        caller, userName: USERS[opts.who].name, messages: history, mode: opts.mode, threadId: null, pin: opts.pin,
      });
      const chunks = chunkStream(res.body!, (c) => {
        if (ttft === null && (c.type === "text-delta" || c.type === "tool-input-start")) ttft = Date.now() - t0;
        if (c.type === "error") streamError = c.errorText;
      });
      for await (const msg of readUIMessageStream<AssistantUIMessage>({ stream: chunks })) final = msg;
    } catch (e) {
      streamError = (e as Error).message;
    }
    const totalMs = Date.now() - t0;
    const parts = final?.parts ?? [];
    const tools: ToolCall[] = parts
      .filter((p) => p.type.startsWith("tool-"))
      .map((p) => {
        const tp = p as unknown as { type: string; input?: Record<string, unknown>; output?: Record<string, unknown>; errorText?: string };
        return { name: tp.type.slice(5), input: tp.input ?? {}, output: tp.output ?? null, error: tp.errorText ?? null };
      });
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
    results.push({
      question, text, tools, ttftMs: ttft, totalMs,
      costUsd: final?.metadata?.costUsd ?? null, model: final?.metadata?.model ?? null, provider: final?.metadata?.provider ?? null,
      error: streamError,
    });
    if (final) history = [...history, { ...final, id: `a${i}` }];
  }
  return results;
}

/** LLM-as-judge on a strong model: is the answer correct, complete, short, grounded in the tool results? */
export async function judge(opts: {
  who: keyof typeof USERS;
  question: string;
  rubric: string;
  answer: string;
  tools: ToolCall[];
}): Promise<{ score: number; reason: string; costUsd: number }> {
  const db = createScopedClient(DEV);
  const chain = await buildProviderChain(db, DEV, "deep", { provider: "anthropic", model: "claude-sonnet-5-5" });
  const evidence = JSON.stringify(opts.tools.map((t) => ({ tool: t.name, input: t.input, output: t.output })), null, 0).slice(0, 150_000);
  const ask = () => generateText({
    model: chain.model,
    reasoning: "low",
    maxOutputTokens: 2_000,
    instructions: `You grade answers from a sales-CRM assistant. The tool results are the ground truth from the database.
Score 1-5:
5 = correct, complete for the question, grounded in the tool results, short and clear.
4 = correct with a minor gap or a little wordy.
3 = partly correct or missing something the user needed.
2 = misleading, or a number not supported by the tool results.
1 = wrong, unsafe, or ignores the question.
Also apply the case rubric. Reply with ONLY JSON: {"score": <1-5>, "reason": "<one sentence>"}

Context the assistant legitimately has (do NOT mark these as unsupported):
- The asker is ${USERS[opts.who].name} (${USERS[opts.who].role}); "you" in the answer means them.
- Today is ${new Date().toISOString().slice(0, 10)}; the assistant knows today's date, so "waited 6 weeks" can be computed from a thread date.
- Times may be shown in India time (UTC+5:30).
- Revealing one email through Apollo costs 1 credit (from the tool's own description).
- The assistant's own product knowledge, below, is a valid source for definitions (what a status means), but not for numbers:
${ASSISTANT_STATIC_PROMPT.split("# How to answer")[0]}`,
    prompt: `QUESTION:\n${opts.question}\n\nCASE RUBRIC:\n${opts.rubric}\n\nTOOL RESULTS:\n${evidence}\n\nANSWER:\n${opts.answer || "(empty)"}`,
  });
  // One retry on a dropped connection — a network blip is not a score.
  let { text, usage } = await ask().catch(() => ask());
  // A judge reply with no JSON is a judge failure, not a low score — ask once more.
  if (!/\{[\s\S]*"score"[\s\S]*\}/.test(text)) ({ text, usage } = await ask());
  const m = /\{[\s\S]*\}/.exec(text);
  let score = 0;
  let reason = "judge returned no JSON";
  try {
    const parsed = JSON.parse(m?.[0] ?? "{}") as { score?: number; reason?: string };
    score = Number(parsed.score ?? 0);
    reason = parsed.reason ?? reason;
  } catch { /* keep defaults */ }
  const inTok = (usage.inputTokens ?? 0);
  const outTok = (usage.outputTokens ?? 0);
  return { score, reason, costUsd: (inTok * 2 + outTok * 10) / 1e6 };
}
