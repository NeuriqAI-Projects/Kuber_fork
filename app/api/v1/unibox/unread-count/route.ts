import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { getUniboxScope } from "@/lib/auth/scope";
import { getUnreadCount } from "@/lib/services/unibox";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "unibox:read"); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const scope = getUniboxScope(user) ?? undefined;
  const count = await getUnreadCount(db, scope);
  return ok({ unread: count });
}
