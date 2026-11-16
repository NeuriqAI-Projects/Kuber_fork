import { NextRequest } from "next/server";
import { assertScope, requireScope } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { getCampaignReplyThreads } from "@/lib/services/unibox";
import { assertCampaignAccess, getUniboxScope } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:read"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try {
    // Reply bodies are inbox content, so the inbox scope too.
    assertScope(user, "unibox:read");
    await assertCampaignAccess(db, user, id);
  } catch (r) { return r as Response; }
  // Without unibox:all, only threads on the caller's own leads — campaign access
  // alone would show a teammate's replies in a shared campaign.
  const threads = await getCampaignReplyThreads(db, id, getUniboxScope(user) ?? undefined);
  return ok({ threads });
}
