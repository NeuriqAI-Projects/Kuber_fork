import { NextRequest, after } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchProviderKeySchema } from "@/lib/validators/provider-keys";
import { dbForUser } from "@/lib/supabase/scoped";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { forgetKeyMemo, isUsableLlmKeyRow, isUsableScrapeKeyRow, kickLlmWork, kickScrapeWork } from "@/lib/services/provider-keys";
import { checkApolloCredits } from "@/lib/services/provider-credits";

export const maxDuration = 60;

const KEY_SELECT = "id, provider, label, secret_last4, priority, is_active, status, cooling_off_until, last_used_at, last_checked_at, last_error, last_error_at, created_at";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchProviderKeySchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  // Manually clearing a key back to healthy (e.g. after fixing a dead key)
  // should also clear its cooldown so it's eligible on the very next
  // getActiveKey() call rather than waiting out a stale cooling_off_until.
  if (parsed.data.status === "healthy") updates.cooling_off_until = null;

  const { data, error } = await db.from("provider_keys").update(updates).eq("id", id).select(KEY_SELECT).maybeSingle();
  if (error) return fail(500, "INTERNAL", error.message);
  if (!data) return fail(404, "NOT_FOUND", "Key not found");
  forgetKeyMemo();
  const keyChanged = parsed.data.status !== undefined || parsed.data.is_active !== undefined;
  // Apollo key turned on/off or marked healthy: save the live balance so the
  // "Apollo out of credits" gates follow at once.
  if (keyChanged && data.provider === "apollo") after(() => checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: true }));
  // Status or on/off changed and the AI key is usable now: start waiting drafts.
  if (keyChanged && isUsableLlmKeyRow(data)) {
    const baseUrl = internalAppBaseUrl(req);
    after(() => kickLlmWork(baseUrl, user.companyId));
  }
  // Same for website scrapes (Firecrawl, or the AI key that writes the profile).
  if (keyChanged && isUsableScrapeKeyRow(data)) {
    const baseUrl = internalAppBaseUrl(req);
    after(() => kickScrapeWork(baseUrl));
  }
  return ok(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  // The provider_keys_delete_vault_secret_trigger cleans up the underlying
  // Vault secret automatically — nothing else to do here.
  const { data: gone, error } = await db.from("provider_keys").delete().eq("id", id).select("provider").maybeSingle();
  if (error) return fail(500, "INTERNAL", error.message);
  forgetKeyMemo();
  if (gone?.provider === "apollo") after(() => checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: true }));
  return ok({ id });
}
