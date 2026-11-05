import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { ProspectSearchSchema } from "@/lib/validators/leads";
import { dbForUser } from "@/lib/supabase/scoped";
import { runProspectSearch } from "@/lib/services/prospects/search";
import { withRouteTiming } from "@/lib/services/route-timing";

export const maxDuration = 60;

/** Company-first scored search, step 1: one Apollo Organization Search page (1 credit). */
export const POST = withRouteTiming("prospects/search", async (req, timing) => {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  timing.companyId = user.companyId;
  if (!user.companyId) return fail(400, "NO_COMPANY", "Pick a company workspace first");

  const parsed = ProspectSearchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const out = await runProspectSearch(dbForUser(user), user.companyId, user.id, parsed.data);
  return out.ok ? ok(out) : fail(out.status, out.code, out.message, out.search_id ? { search_id: out.search_id } : undefined);
});
