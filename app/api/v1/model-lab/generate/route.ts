import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { runLabComparison } from "@/lib/services/model-lab";

export const maxDuration = 300;

const Schema = z.object({
  lead_id: dbId,
  step_number: z.number().int().min(1).max(6).default(1),
  models: z.array(z.string().min(1)).min(1).max(8),
  prompt_set_id: dbId.nullable().optional(),
  /** Unsaved wording typed straight into the lab. `null` means "deliberately
   *  blank"; omit the field entirely to use whatever is saved in Settings. */
  template: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
});

/**
 * Write one email per model for one lead, and store them for judging.
 *
 * Nothing is sent and no campaign is touched — see lib/services/model-lab.ts
 * for how the carrier campaigns keep the real generator's behaviour intact.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");
  if (!user.companyId) return fail(400, "VALIDATION_ERROR", "No company on this account");

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const hasOverride = parsed.data.template !== undefined || parsed.data.prompt !== undefined;

  try {
    const { runGroup, emails } = await runLabComparison(db, {
      companyId: user.companyId,
      userId: user.id,
      leadId: parsed.data.lead_id,
      stepNumber: parsed.data.step_number,
      models: parsed.data.models,
      promptSetId: parsed.data.prompt_set_id ?? null,
      override: hasOverride
        ? { template: parsed.data.template, prompt: parsed.data.prompt }
        : undefined,
    });
    return ok({ run_group: runGroup, emails });
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
