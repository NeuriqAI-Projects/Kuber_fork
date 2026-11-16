import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { ok, fail } from "@/lib/api-response";
import { getImports } from "@/lib/server/imports";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "leads:read"); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  try {
    const imports = await getImports(db, {
      assignedTo: canSeeAll(user.member, "leads") ? undefined : user.id,
      companyId: user.companyId,
    });
    return ok({ imports });
  } catch (e) {
    return fail(500, "INTERNAL", e instanceof Error ? e.message : "Failed to load imports");
  }
}
