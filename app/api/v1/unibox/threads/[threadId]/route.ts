import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { getThreadMessages, hydrateThreadIfStale } from "@/lib/services/unibox";
import { assertThreadAccess, assertThreadAccessById } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "unibox:read"); } catch (r) { return r as Response; }
  const { threadId } = await params;
  const db = dbForUser(user);

  // Hydrate fetches from Instantly and writes rows, so it runs only after the
  // caller is known to be allowed this thread.
  if (req.nextUrl.searchParams.get("hydrate") === "1") {
    try { await assertThreadAccessById(db, user, threadId); } catch (r) { return r as Response; }
    await hydrateThreadIfStale(db, threadId);
  }

  const detail = await getThreadMessages(db, threadId);
  try {
    await assertThreadAccess(db, user, {
      campaignId: (detail.campaign as { id?: string } | null)?.id ?? null,
      campaignLeadId: detail.campaign_lead_id,
    });
  } catch (r) {
    return r as Response;
  }
  return ok(detail);
}
