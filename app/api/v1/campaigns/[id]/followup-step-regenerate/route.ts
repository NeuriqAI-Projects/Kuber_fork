import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { FollowUpStepTemplateRegenerateSchema } from "@/lib/validators/drafts";
import { regenerateFollowUpTemplateText } from "@/lib/services/followup-regenerate";
import { assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Campaign-level follow-up template rewrite for the Sequences tab — no per-lead
// draft writes; the client saves via PUT .../steps when the user clicks Save.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:generate"); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = FollowUpStepTemplateRegenerateSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  // The campaign id is written into llm_usage tagging, and the result is a
  // campaign-wide step template, so: a real campaign the caller may change.
  try { await assertCampaignSettingsAccess(dbForUser(user), user, id); } catch (r) { return r as Response; }

  try {
    const rewritten = await regenerateFollowUpTemplateText({
      currentBody: parsed.data.body,
      instruction: parsed.data.instruction ?? "Rewrite this follow-up.",
      companyId: user.companyId ?? "any",
      campaignId: id,
    });
    return ok({ body: rewritten.body });
  } catch (e) {
    return fail(502, "GENERATION_FAILED", (e as Error).message);
  }
}
