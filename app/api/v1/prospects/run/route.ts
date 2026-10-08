import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { createAdminClient } from "@/lib/supabase/admin";
import { runProspectWorker } from "@/lib/services/prospects/worker";

export const maxDuration = 55;

/** "Process now" for the signed-in company — the same pass the minute pump makes. */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  if (!user.companyId) return fail(400, "NO_COMPANY", "Pick a company workspace first");
  return ok(await runProspectWorker(createAdminClient(), user.companyId));
}
