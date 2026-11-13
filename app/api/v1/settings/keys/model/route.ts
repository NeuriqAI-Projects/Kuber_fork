import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { SetProviderModelSchema } from "@/lib/validators/provider-keys";
import { PROVIDER_META } from "@/lib/services/providers/registry";
import { dbForUser } from "@/lib/supabase/scoped";
import { forgetLlmConfigMemo } from "@/lib/services/llm";

export const maxDuration = 60;

export async function PUT(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = SetProviderModelSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { provider, model } = parsed.data;

  if (!(provider in PROVIDER_META)) return fail(400, "INVALID_PROVIDER", `Unknown provider "${provider}"`);

  const db = dbForUser(caller);
  // null clears back to the env var / hardcoded default (see resolveModel()).
  const { data, error } = await db
    .from("provider_settings")
    .upsert({ provider, selected_model: model, updated_by: caller.id, updated_at: new Date().toISOString() }, { onConflict: "provider" })
    .select()
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  forgetLlmConfigMemo();
  return ok(data);
}
