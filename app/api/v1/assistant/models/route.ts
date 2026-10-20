import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { PROVIDER_META, resolveLlmTierOrder, type LlmProviderId } from "@/lib/services/providers/registry";
import { getActiveKey } from "@/lib/services/provider-keys";
import { invalidateAssistantCaches } from "@/lib/services/assistant/provider-chain";
import {
  ASSISTANT_MODEL_DEFAULTS, getAssistantModelOverrides, saveAssistantModelOverrides,
} from "@/lib/services/assistant/models";

const LLM_IDS = Object.keys(ASSISTANT_MODEL_DEFAULTS) as LlmProviderId[];

/** GET /api/v1/assistant/models — which model the assistant uses per provider and mode. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  if (!user.companyId) return fail(403, "FORBIDDEN", "Company users only");
  const db = dbForUser(user);
  const [order, overrides] = await Promise.all([resolveLlmTierOrder(db), getAssistantModelOverrides(db)]);
  const configured = await Promise.all(order.map(async (p) => [p, !!(await getActiveKey(db, p, user.companyId!))] as const));
  const hasKey = new Map(configured);
  return ok({
    providers: order.map((id) => ({
      id,
      label: PROVIDER_META[id].label,
      configured: hasKey.get(id) ?? false,
      defaults: ASSISTANT_MODEL_DEFAULTS[id],
      overrides: overrides[id] ?? {},
    })),
  });
}

const PutSchema = z.object({
  provider: z.enum(LLM_IDS as [LlmProviderId, ...LlmProviderId[]]),
  fast: z.string().trim().max(200).nullable().optional(),
  deep: z.string().trim().max(200).nullable().optional(),
});

/** PUT /api/v1/assistant/models — set (or clear with null) the fast/deep model for one provider. */
export async function PUT(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  if (!user.companyId) return fail(403, "FORBIDDEN", "Company users only");
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const db = dbForUser(user);
  const overrides = await getAssistantModelOverrides(db);
  const entry = { ...(overrides[parsed.data.provider] ?? {}) };
  for (const role of ["fast", "deep"] as const) {
    const v = parsed.data[role];
    if (v === undefined) continue;
    if (v === null || v === "") delete entry[role];
    else entry[role] = v;
  }
  overrides[parsed.data.provider] = entry;
  try {
    await saveAssistantModelOverrides(db, overrides);
    invalidateAssistantCaches(user.companyId);
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
  return ok({ provider: parsed.data.provider, overrides: entry });
}
