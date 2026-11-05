import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

/** Lightweight sidebar readout — remaining / plan limit for the active Apollo key.
 *  Reads the last saved balance only (any age): the app refreshes it whenever it
 *  really uses Apollo (every pre-spend check, after each reveal batch) and the
 *  Settings > Keys > Usage refresh button reads it live. Only when nothing was
 *  ever saved does this call Apollo once. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const check = await checkApolloCredits(db, "any" /* one shared Apollo account */, { savedOnly: true });
  return ok({
    remaining: check.remaining,
    limit: check.limit ?? null,
  });
}
