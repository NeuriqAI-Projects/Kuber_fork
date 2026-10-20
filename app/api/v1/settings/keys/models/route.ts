import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PROVIDER_META, type LlmProviderId } from "@/lib/services/providers/registry";
import { getActiveKey, getProviderCallConfig } from "@/lib/services/provider-keys";
import { listProviderModels, type ProviderModelOption } from "@/lib/services/model-catalog";
import type { ProviderId } from "@/lib/services/providers/types";
import { dbForUser } from "@/lib/supabase/scoped";

export type { ProviderModelOption };

/** GET /api/v1/settings/keys/models?provider=openrouter — live model catalog
 *  for the picker in Settings > Keys, fetched with the provider's configured
 *  key so the list always reflects what that key can actually use. Providers
 *  without a catalog integration return an empty list and the UI falls back
 *  to its static options / freeform input. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const provider = req.nextUrl.searchParams.get("provider") as ProviderId | null;
  if (!provider || !(provider in PROVIDER_META)) {
    return fail(400, "INVALID_PROVIDER", `Unknown provider "${provider}"`);
  }
  if (PROVIDER_META[provider].category !== "llm") {
    return fail(400, "INVALID_PROVIDER", `${provider} has no model catalog`);
  }

  const db = dbForUser(user);
  const key = await getActiveKey(db, provider, user.companyId ?? "any");

  try {
    if (!key && provider !== "openrouter") {
      return fail(400, "NO_KEY", `Add a ${PROVIDER_META[provider].label} key first to load its model list`);
    }
    const config = await getProviderCallConfig(db, provider);
    const models = await listProviderModels(provider as LlmProviderId, key?.secret ?? null, {
      anthropicWorkspaceId: config.workspaceId,
    });
    return ok({ models });
  } catch (e) {
    return fail(502, "PROVIDER_ERROR", (e as Error).message);
  }
}
