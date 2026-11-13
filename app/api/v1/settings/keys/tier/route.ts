import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { SetLlmTierRolesSchema } from "@/lib/validators/provider-keys";
import { DEFAULT_LLM_TIER_ORDER } from "@/lib/services/providers/registry";
import { dbForUser } from "@/lib/supabase/scoped";
import { forgetLlmConfigMemo } from "@/lib/services/llm";

export const maxDuration = 60;

// Sets which LLM provider complete() tries first ("Primary") and second
// ("Fallback") — everything else configured still gets tried afterward, in
// DEFAULT_LLM_TIER_ORDER's relative order (see resolveLlmTierOrder()). This
// only reorders the front of the list, it never drops a provider.
export async function PUT(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = SetLlmTierRolesSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { primary, fallback } = parsed.data;

  if (primary && !DEFAULT_LLM_TIER_ORDER.includes(primary as (typeof DEFAULT_LLM_TIER_ORDER)[number])) {
    return fail(400, "INVALID_PROVIDER", `Unknown LLM provider "${primary}"`);
  }
  if (fallback && !DEFAULT_LLM_TIER_ORDER.includes(fallback as (typeof DEFAULT_LLM_TIER_ORDER)[number])) {
    return fail(400, "INVALID_PROVIDER", `Unknown LLM provider "${fallback}"`);
  }
  if (primary && fallback && primary === fallback) {
    return fail(400, "VALIDATION_ERROR", "Primary and fallback must be different providers");
  }

  const db = dbForUser(caller);
  const { data, error } = await db
    .from("llm_tier_config")
    .upsert(
      { id: true, primary_provider: primary, fallback_provider: fallback, updated_by: caller.id, updated_at: new Date().toISOString() },
      // The row identity is the company: llm_tier_config's PK moved from the
      // `id boolean` singleton to (company_id) in the multi-tenant migration.
      { onConflict: "company_id" },
    )
    .select("primary_provider, fallback_provider")
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  forgetLlmConfigMemo();
  return ok({ primary: data.primary_provider, fallback: data.fallback_provider });
}
