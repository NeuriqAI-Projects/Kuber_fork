import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { addKeyword } from "@/lib/services/prospects/keywords";

const Body = z.object({ group_id: z.string().min(1), label: z.string().trim().min(1).max(200), query: z.string().trim().max(200).optional() });

/** POST: add ONE keyword to ONE Industry Segments group, safe against a teammate adding at the same time
 *  (the whole-settings PATCH was last-write-wins). Answers the saved groups; 409 on a duplicate. */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { group_id, label, query } = parsed.data;
  try {
    const r = await addKeyword(dbForUser(user), { groupId: group_id, label, query: query || label });
    if (r.ok) return ok({ groups: r.groups });
    return fail(r.code === "BUSY" ? 503 : 409, r.code, r.message, { groups: r.groups });
  } catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
}
