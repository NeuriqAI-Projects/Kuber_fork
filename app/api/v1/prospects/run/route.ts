import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { createAdminClient } from "@/lib/supabase/admin";
import { revealPromoted, runProspectWorker } from "@/lib/services/prospects/worker";
import { withRouteTiming } from "@/lib/services/route-timing";

export const maxDuration = 60;

/** "Process now" for the signed-in company — the same pass the minute pump makes. */
export const POST = withRouteTiming("prospects/run", async (req, timing) => {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  timing.companyId = user.companyId;
  if (!user.companyId) return fail(400, "NO_COMPANY", "Pick a company workspace first");
  const admin = createAdminClient();
  const r = await runProspectWorker(admin, user.companyId);
  revealPromoted(req, admin, r.promotedImports);
  return ok(r);
});
