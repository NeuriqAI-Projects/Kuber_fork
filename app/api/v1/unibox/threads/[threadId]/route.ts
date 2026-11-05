import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { getThreadMessages, hydrateThreadIfStale } from "@/lib/services/unibox";
import { assertThreadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { threadId } = await params;
  const db = dbForUser(user);

  if (req.nextUrl.searchParams.get("hydrate") === "1") {
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
