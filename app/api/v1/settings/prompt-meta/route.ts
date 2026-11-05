import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const { data } = await db
    .from("settings")
    .select("updated_at")
    .eq("key", "system_prompt")
    .maybeSingle();
  return ok({ updatedAt: data?.updated_at ?? null });
}
