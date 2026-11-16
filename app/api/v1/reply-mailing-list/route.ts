import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { listReplyAddresses } from "@/lib/services/reply-mailing-list";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "unibox:reply"); } catch (r) { return r as Response; }

  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit as number) < 1)) {
    return fail(400, "VALIDATION_ERROR", "limit must be a positive number");
  }

  const db = dbForUser(user);
  const emails = await listReplyAddresses(db, user.id, { q, limit });
  return ok({ emails });
}
