// One AI SDK model that is really the company's whole provider try-order.
//
// complete() in llm.ts already tries Primary, then Fallback, then the rest,
// rotating keys inside each provider. The assistant needs the same behaviour
// but streaming and with tool calls, which complete() does not do. Rather than
// a second copy of that loop around streamText, the loop lives in a model
// middleware: streamText sees one model; each step's request goes to the
// provider that served the previous step (so a conversation never flips models
// mid-answer), and only a failure before any output moves on to the next key
// or provider.
import type { SupabaseClient } from "@supabase/supabase-js";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { getActiveKey, getProviderCallConfig, markKeyFailed, markKeySucceeded } from "@/lib/services/provider-keys";
import { resolveLlmTierOrder, type LlmProviderId } from "@/lib/services/providers/registry";
import { getAssistantModelOverrides, resolveAssistantModel, type AssistantModelRole } from "@/lib/services/assistant/models";

/** Build one provider's model. Every provider reads the same portable options
 *  (`reasoning`, tools, messages) — provider quirks stay inside the AI SDK. */
export function createProviderModel(
  provider: LlmProviderId,
  modelId: string,
  secret: string,
  opts?: { anthropicWorkspaceId?: string | null },
): LanguageModelV4 {
  switch (provider) {
    case "anthropic":
      return createAnthropic({
        apiKey: secret,
        headers: opts?.anthropicWorkspaceId ? { "anthropic-workspace-id": opts.anthropicWorkspaceId } : undefined,
      })(modelId) as LanguageModelV4;
    case "openai":
      return createOpenAI({ apiKey: secret })(modelId) as LanguageModelV4;
    case "gemini":
      return createGoogle({ apiKey: secret })(modelId) as LanguageModelV4;
    case "mistral":
      return createMistral({ apiKey: secret })(modelId) as LanguageModelV4;
    case "groq":
      return createGroq({ apiKey: secret })(modelId) as LanguageModelV4;
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: secret,
        includeUsage: true,
        headers: {
          "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
          "X-Title": "Kuber Polyplast",
        },
      }).chatModel(modelId) as LanguageModelV4;
  }
}

/** Which provider/model/key actually answered — read after the stream ends, for usage logging. */
export type ServedBy = { provider: LlmProviderId; model: string; keyId: string | null; tier: number };

export type ProviderChain = {
  model: LanguageModel;
  servedBy: () => ServedBy | null;
  /** Providers that failed before one answered, with their error — logged as failed usage rows. */
  failures: () => Array<{ provider: LlmProviderId; model: string; tier: number; error: string }>;
};

type Candidate = { provider: LlmProviderId; model: string; keyId: string | null; tier: number; instance: LanguageModelV4 };

/** HTTP statuses that mean "this key is the problem" — rotate it out. A 400 is
 *  a bad request (or an unknown model id): the key is fine, the next provider
 *  may still answer, so we move on without marking the key failed. */
function isKeyFailure(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number };
  return e?.statusCode ?? e?.status;
}

/**
 * Per-instance caches. Building the chain used to cost four sequential
 * database round-trips (try-order, model overrides, key + vault read, Anthropic
 * workspace) before the model was even called — over a second on every
 * question. Fluid compute reuses instances, so a short cache removes that. A
 * failing key is dropped from the cache at once (see withFallback).
 */
const CONFIG_TTL_MS = 60_000;
const KEY_TTL_MS = 5 * 60_000;
const configCache = new Map<string, { at: number; value: Promise<[LlmProviderId[], Awaited<ReturnType<typeof getAssistantModelOverrides>>]> }>();
const keyCache = new Map<string, { at: number; value: Promise<{ key: Awaited<ReturnType<typeof getActiveKey>>; workspaceId: string | null }> }>();

function cachedConfig(db: SupabaseClient, companyId: string) {
  const hit = configCache.get(companyId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value;
  const value = Promise.all([resolveLlmTierOrder(db), getAssistantModelOverrides(db)]);
  configCache.set(companyId, { at: Date.now(), value });
  value.catch(() => configCache.delete(companyId));
  return value;
}

function cachedKey(db: SupabaseClient, companyId: string, provider: LlmProviderId, exclude: Set<string>) {
  // A rotation (keys already tried this request) always reads fresh.
  if (exclude.size > 0) {
    return Promise.all([getActiveKey(db, provider, companyId, { exclude }), getProviderCallConfig(db, provider)])
      .then(([key, config]) => ({ key, workspaceId: config.workspaceId ?? null }));
  }
  const id = `${companyId}:${provider}`;
  const hit = keyCache.get(id);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.value;
  const value = Promise.all([getActiveKey(db, provider, companyId), getProviderCallConfig(db, provider)])
    .then(([key, config]) => ({ key, workspaceId: config.workspaceId ?? null }));
  keyCache.set(id, { at: Date.now(), value });
  value.catch(() => keyCache.delete(id));
  return value;
}

/** Forget a company's cached key/config — after a key fails, or when an admin changes settings. */
export function invalidateAssistantCaches(companyId: string, provider?: LlmProviderId) {
  configCache.delete(companyId);
  for (const k of [...keyCache.keys()]) {
    if (k.startsWith(`${companyId}:`) && (!provider || k === `${companyId}:${provider}`)) keyCache.delete(k);
  }
}

export async function buildProviderChain(
  db: SupabaseClient,
  companyId: string,
  role: AssistantModelRole,
  opts?: { provider?: LlmProviderId; model?: string },
): Promise<ProviderChain> {
  const [defaultOrder, overrides] = await cachedConfig(db, companyId);
  const tierOrder = opts?.provider ? [opts.provider] : defaultOrder;

  let current: Candidate | null = null;
  let providerIndex = 0;
  const triedKeys = new Map<LlmProviderId, Set<string>>();
  const failures: Array<{ provider: LlmProviderId; model: string; tier: number; error: string }> = [];

  /** Next usable (provider, key) after the current one, or null when every tier is exhausted. */
  async function nextCandidate(): Promise<Candidate | null> {
    while (providerIndex < tierOrder.length) {
      const provider = tierOrder[providerIndex];
      const tried = triedKeys.get(provider) ?? new Set<string>();
      triedKeys.set(provider, tried);
      const { key, workspaceId } = await cachedKey(db, companyId, provider, tried);
      // An env-sourced key has no id, so it can only be tried once.
      if (key && !(key.keyId === null && tried.has("env")) && !(key.keyId && tried.has(key.keyId))) {
        tried.add(key.keyId ?? "env");
        const model = opts?.model ?? resolveAssistantModel(provider, role, overrides);
        return {
          provider, model, keyId: key.keyId, tier: providerIndex + 1,
          instance: createProviderModel(provider, model, key.secret, { anthropicWorkspaceId: workspaceId }),
        };
      }
      providerIndex++;
    }
    return null;
  }

  async function withFallback<T>(run: (m: LanguageModelV4) => PromiseLike<T>): Promise<T> {
    if (!current) current = await nextCandidate();
    for (;;) {
      if (!current) {
        const detail = failures.map((f) => `${f.provider}: ${f.error}`).join(" | ");
        throw new Error(detail ? `Every AI provider failed — ${detail}` : "No AI provider is configured — add a key in Credits > AI.");
      }
      try {
        const out = await run(current.instance);
        if (current.keyId) await markKeySucceeded(db, current.keyId).catch(() => {});
        return out;
      } catch (err) {
        const status = statusOf(err);
        const message = (err as Error)?.message ?? String(err);
        failures.push({ provider: current.provider, model: current.model, tier: current.tier, error: message.slice(0, 300) });
        invalidateAssistantCaches(companyId, current.provider);
        if (current.keyId && isKeyFailure(status)) {
          await markKeyFailed(db, current.keyId, { status, message }).catch(() => {});
        } else {
          // Not the key's fault: skip the rest of this provider's keys too.
          providerIndex++;
        }
        current = await nextCandidate();
      }
    }
  }

  const first = await nextCandidate();
  if (!first) {
    throw new Error("No AI provider is configured — add a key in Credits > AI.");
  }
  current = first;

  const model = wrapLanguageModel({
    model: first.instance,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: ({ params }) => withFallback((m) => m.doGenerate(params)),
      wrapStream: ({ params }) => withFallback((m) => m.doStream(params)),
    },
  });

  return {
    model,
    servedBy: () => (current ? { provider: current.provider, model: current.model, keyId: current.keyId, tier: current.tier } : null),
    failures: () => failures,
  };
}
