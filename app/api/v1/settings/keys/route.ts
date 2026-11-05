import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CreateProviderKeySchema } from "@/lib/validators/provider-keys";
import { getLlmTierRoles, PROVIDER_META, resolveLlmTierOrder } from "@/lib/services/providers/registry";
import { ENV_KEY_VARS } from "@/lib/services/provider-keys";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

type ProviderKeyRow = {
  id: string; provider: string; label: string; secret_last4: string;
  priority: number; is_active: boolean; status: string;
  cooling_off_until: string | null; last_used_at: string | null;
  last_checked_at: string | null; last_error: string | null;
  last_error_at: string | null; created_at: string;
};

const KEY_SELECT = "id, provider, label, secret_last4, priority, is_active, status, cooling_off_until, last_used_at, last_checked_at, last_error, last_error_at, created_at";

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const [{ data: keys }, { data: settings }, tierRoles, tierOrder] = await Promise.all([
    db.from("provider_keys").select(KEY_SELECT).order("priority", { ascending: true }),
    db.from("provider_settings").select("provider, selected_model"),
    getLlmTierRoles(db),
    resolveLlmTierOrder(db),
  ]);

  const modelByProvider = new Map((settings ?? []).map((s) => [s.provider, s.selected_model as string | null]));
  const keysByProvider = new Map<string, ProviderKeyRow[]>();
  for (const k of (keys ?? []) as ProviderKeyRow[]) {
    const list = keysByProvider.get(k.provider) ?? [];
    list.push(k);
    keysByProvider.set(k.provider, list);
  }

  // envFallback tells the UI "no key here, but the integration still works off
  // .env.local" — without it a configured-via-env provider reads as broken.
  const envConfigured = new Set(
    Object.values(PROVIDER_META)
      .filter((meta) => !!process.env[ENV_KEY_VARS[meta.id]]?.trim())
      .map((meta) => meta.id),
  );

  const providers = Object.values(PROVIDER_META).map((meta) => ({
    id: meta.id,
    category: meta.category,
    label: meta.label,
    description: meta.description ?? null,
    modelInputMode: meta.modelInputMode,
    modelOptions: meta.modelOptions ?? [],
    defaultModel: meta.defaultModel ?? null,
    selectedModel: modelByProvider.get(meta.id) ?? null,
    envFallback: envConfigured.has(meta.id),
    keys: keysByProvider.get(meta.id) ?? [],
  }));

  return ok({ providers, tierRoles, tierOrder });
}

export async function POST(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = CreateProviderKeySchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { provider, label, secret } = parsed.data;

  // Provider ids are validated against the code registry, not a DB
  // constraint — adding a new provider later never needs a migration.
  if (!(provider in PROVIDER_META)) return fail(400, "INVALID_PROVIDER", `Unknown provider "${provider}"`);

  const db = dbForUser(caller);

  const { data: vaultId, error: vaultError } = await db.rpc("provider_key_create_secret", {
    p_secret: secret,
    p_name: `provider_key_${provider}_${crypto.randomUUID()}`,
  });
  if (vaultError || !vaultId) return fail(500, "VAULT_ERROR", vaultError?.message ?? "Could not store secret");

  const { data: existingMax } = await db
    .from("provider_keys")
    .select("priority")
    .eq("provider", provider)
    .order("priority", { ascending: false })
    .limit(1)
    .maybeSingle();
  const priority = (existingMax?.priority ?? 0) + 10;

  const { data: created, error } = await db
    .from("provider_keys")
    .insert({
      provider,
      label,
      secret_vault_id: vaultId,
      secret_last4: secret.slice(-4),
      priority,
      created_by: caller.id,
    })
    .select(KEY_SELECT)
    .single();

  if (error) {
    // Roll back the orphaned Vault secret rather than leaving it dangling.
    try { await db.rpc("provider_key_delete_secret", { p_vault_id: vaultId }); } catch { /* best effort */ }
    return fail(500, "INTERNAL", error.message);
  }
  return ok(created);
}
