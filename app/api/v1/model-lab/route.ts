import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { getBenchLeadIds, getLabModels, getScoreboard, setSetting, BENCH_LEADS_KEY, LAB_MODELS_KEY } from "@/lib/services/model-lab";

/** Everything the lab screen needs to open: the bench, the candidates, the
 *  saved prompt sets and the scoreboard. Managers only — the lab spends money
 *  and decides what writes to customers. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");

  const db = dbForUser(user);
  const [leadIds, models, scoreboard] = await Promise.all([
    getBenchLeadIds(db), getLabModels(db), getScoreboard(db),
  ]);

  const { data: leads } = leadIds.length
    ? await db.from("leads")
        .select("id, first_name, last_name, title, country, organizations(name, industry, company_description)")
        .in("id", leadIds)
    : { data: [] };

  const { data: promptSets } = await db
    .from("model_lab_prompt_sets")
    .select("id, name, scope, template, prompt, created_at")
    .order("created_at", { ascending: true });

  // Ordered as the bench is stored, not as Postgres returned them.
  const byId = new Map((leads ?? []).map((l) => [l.id as string, l]));
  return ok({
    bench: leadIds.map((id) => byId.get(id)).filter(Boolean),
    models,
    prompt_sets: promptSets ?? [],
    scoreboard,
  });
}

/** Change the bench, or which models are offered. */
export async function PUT(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");

  const body = await req.json().catch(() => null) as { lead_ids?: string[]; models?: string[] } | null;
  if (!body) return fail(400, "VALIDATION_ERROR", "Invalid request");

  const db = dbForUser(user);
  if (Array.isArray(body.lead_ids)) await setSetting(db, BENCH_LEADS_KEY, body.lead_ids.slice(0, 12));
  if (Array.isArray(body.models)) await setSetting(db, LAB_MODELS_KEY, body.models.slice(0, 12));
  return ok({ updated: true });
}
