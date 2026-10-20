// Live model catalogs, one per LLM provider, fetched with the company's own key.
//
// The static lists in providers/registry.ts go stale every few weeks (they did:
// the picker was still offering Claude 4.x after the 5.5 generation shipped).
// Each provider publishes its own list, so the picker reads that instead and
// the static list is only the fallback when no key is stored yet.
import type { LlmProviderId } from "@/lib/services/providers/registry";

export type ProviderModelOption = { id: string; name: string | null; created?: number | null };

// OpenAI's /v1/models returns every model family (embeddings, TTS, image,
// moderation…). Only chat models make sense as the app's LLM.
const OPENAI_NON_CHAT = /embedding|whisper|tts|dall-e|audio|realtime|moderation|transcribe|image|babbage|davinci|codex|search/i;
// Same idea for the OpenAI-compatible catalogs (Mistral, Groq).
const NON_CHAT = /embed|whisper|tts|guard|moderation|ocr|transcri|audio|speech|image|vision-only/i;

async function getJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

async function listOpenRouter(secret: string | null): Promise<ProviderModelOption[]> {
  // Public catalog endpoint — the key is optional but sent when present.
  const data = await getJson<{ data?: Array<{ id: string; name?: string; created?: number; supported_parameters?: string[] }> }>(
    "https://openrouter.ai/api/v1/models",
    { headers: secret ? { Authorization: `Bearer ${secret}` } : undefined },
    "OpenRouter",
  );
  return (data.data ?? [])
    .filter((m) => !m.id.endsWith(":batch"))
    .map((m) => ({ id: m.id, name: m.name ?? null, created: m.created ?? null }));
}

async function listOpenAi(secret: string): Promise<ProviderModelOption[]> {
  const data = await getJson<{ data?: Array<{ id: string; created?: number }> }>(
    "https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${secret}` } }, "OpenAI",
  );
  return (data.data ?? [])
    .filter((m) => !OPENAI_NON_CHAT.test(m.id))
    .map((m) => ({ id: m.id, name: null, created: m.created ?? null }));
}

async function listAnthropic(secret: string, workspaceId?: string | null): Promise<ProviderModelOption[]> {
  const data = await getJson<{ data?: Array<{ id: string; display_name?: string; created_at?: string }> }>(
    "https://api.anthropic.com/v1/models?limit=100",
    {
      headers: {
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
        ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
      },
    },
    "Anthropic",
  );
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.display_name ?? null,
    created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) : null,
  }));
}

async function listGemini(secret: string): Promise<ProviderModelOption[]> {
  const data = await getJson<{ models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }>(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(secret)}`, {}, "Gemini",
  );
  return (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName ?? null, created: null }));
}

async function listOpenAiCompatible(url: string, label: string, secret: string): Promise<ProviderModelOption[]> {
  const data = await getJson<{ data?: Array<{ id: string; created?: number; name?: string }> }>(
    url, { headers: { Authorization: `Bearer ${secret}` } }, label,
  );
  return (data.data ?? [])
    .filter((m) => !NON_CHAT.test(m.id))
    .map((m) => ({ id: m.id, name: m.name ?? null, created: m.created ?? null }));
}

/** Newest first when the provider says when a model was created, otherwise by id. */
export function sortCatalog(models: ProviderModelOption[]): ProviderModelOption[] {
  return [...models].sort((a, b) => {
    const ca = a.created ?? 0;
    const cb = b.created ?? 0;
    if (ca !== cb) return cb - ca;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The provider's live model list. `secret` may be null only for OpenRouter,
 * whose catalog is public; every other provider throws without one.
 */
export async function listProviderModels(
  provider: LlmProviderId,
  secret: string | null,
  opts?: { anthropicWorkspaceId?: string | null },
): Promise<ProviderModelOption[]> {
  if (provider === "openrouter") return sortCatalog(await listOpenRouter(secret));
  if (!secret) throw new Error(`Add a ${provider} key first to load its model list`);
  switch (provider) {
    case "openai": return sortCatalog(await listOpenAi(secret));
    case "anthropic": return sortCatalog(await listAnthropic(secret, opts?.anthropicWorkspaceId));
    case "gemini": return sortCatalog(await listGemini(secret));
    case "mistral": return sortCatalog(await listOpenAiCompatible("https://api.mistral.ai/v1/models", "Mistral", secret));
    case "groq": return sortCatalog(await listOpenAiCompatible("https://api.groq.com/openai/v1/models", "Groq", secret));
  }
}
