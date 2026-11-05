import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { assertThreadAccessById } from "@/lib/auth/scope";
import { markThreadUnread } from "@/lib/services/unibox";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { threadId } = await params;
  const db = dbForUser(user);
  try { await assertThreadAccessById(db, user, threadId); } catch (r) { return r as Response; }
  await markThreadUnread(db, threadId);
  return ok({ unread: true });
}
