import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { ReorderProviderKeysSchema } from "@/lib/validators/provider-keys";
import { dbForUser } from "@/lib/supabase/scoped";
import { forgetKeyMemo } from "@/lib/services/provider-keys";

export const maxDuration = 60;

export async function PUT(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = ReorderProviderKeysSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { provider, orderedIds } = parsed.data;

  const db = dbForUser(user);
  const nowIso = new Date().toISOString();
  // Sequential updates keep this simple for the tiny row counts expected
  // here (a handful of keys per provider) — no bulk-upsert RPC needed.
  for (let i = 0; i < orderedIds.length; i++) {
    await db.from("provider_keys")
      .update({ priority: (i + 1) * 10, updated_at: nowIso })
      .eq("id", orderedIds[i])
      .eq("provider", provider);
  }

  forgetKeyMemo();
  return ok({ provider, orderedIds });
}
