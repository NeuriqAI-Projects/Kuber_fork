import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { complete, draftingProviders, providerLabel } from "@/lib/services/llm";
import { isMockCampaign, mockAiAvailable, MOCK_PRIMARY } from "@/lib/services/llm-mock";
import { isProviderOutage } from "@/lib/services/provider-errors";

/**
 * Can the main AI model write emails right now? Asked when a campaign is
 * created, so "no credits" is said up front instead of discovered halfway.
 *
 * AI providers do not report a balance, and a key that merely validates (the
 * Settings Re-check) can still be out of credits. So when the key looks fine
 * this makes one tiny real call: about 30 tokens, a fraction of a paisa. A key
 * already marked dead skips the call. A failure that is not about credits or
 * the key (a garbled reply, say) counts as available: drafting will retry.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const companyId = user.companyId;
  if (!companyId) return fail(400, "NO_COMPANY", "No workspace");

  const body = await req.json().catch(() => ({})) as { campaign_name?: string };
  const name = body.campaign_name ?? "";
  if (isMockCampaign(companyId, name)) {
    const available = await mockAiAvailable(dbForUser(user), null, name);
    return ok({ available, model: MOCK_PRIMARY });
  }

  const { primary, primaryUsable } = await draftingProviders(companyId);
  const model = providerLabel(primary);
  if (!primary || !primaryUsable) return ok({ available: false, model });

  try {
    await complete({
      system: 'Reply with exactly this JSON: {"ok":true}',
      user: "ping",
      maxTokens: 20,
      provider: primary,
    }, companyId, { purpose: "other" });
    return ok({ available: true, model });
  } catch (err) {
    return ok({ available: !isProviderOutage((err as Error).message), model });
  }
}
