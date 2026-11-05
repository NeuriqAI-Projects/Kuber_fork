import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getImports } from "@/lib/server/imports";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  try {
    const imports = await getImports(db, {
      assignedTo: user.role === "employee" ? user.id : undefined,
    });
    return ok({ imports });
  } catch (e) {
    return fail(500, "INTERNAL", e instanceof Error ? e.message : "Failed to load imports");
  }
}
