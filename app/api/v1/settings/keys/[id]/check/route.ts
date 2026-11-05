import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { checkSpecificKey } from "@/lib/services/provider-credits";
import { PROVIDER_META } from "@/lib/services/providers/registry";
import type { ProviderId } from "@/lib/services/providers/types";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Live-validates ONE specific stored key right now — bypasses the "currently
// active key" resolution and the 5-minute cache entirely (the whole point of
// the Re-check button is to test this exact key immediately).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  const { data: keyRow } = await db.from("provider_keys").select("id, provider, secret_vault_id").eq("id", id).maybeSingle();
  if (!keyRow) return fail(404, "NOT_FOUND", "Key not found");
  if (!(keyRow.provider in PROVIDER_META)) return fail(400, "INVALID_PROVIDER", `Unknown provider "${keyRow.provider}"`);

  const { data: secret } = await db.rpc("provider_key_read_secret", { p_vault_id: keyRow.secret_vault_id });
  if (typeof secret !== "string" || !secret) return fail(500, "VAULT_ERROR", "Could not read the stored secret");

  const result = await checkSpecificKey(keyRow.provider as ProviderId, secret);
  const nowIso = new Date().toISOString();

  await db.from("provider_keys").update({
    status: result.ok ? "healthy" : "dead",
    cooling_off_until: null,
    last_checked_at: nowIso,
    updated_at: nowIso,
    last_error: result.ok ? null : result.message,
    last_error_at: result.ok ? null : nowIso,
  }).eq("id", id);

  return ok({ id, ...result });
}
