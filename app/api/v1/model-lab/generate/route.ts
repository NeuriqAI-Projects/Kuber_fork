import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { runLabComparison } from "@/lib/services/model-lab";

export const maxDuration = 300;

const Schema = z.object({
  lead_id: dbId,
  step_number: z.number().int().min(1).max(6).default(1),
  models: z.array(z.string().min(1)).min(1).max(8),
  prompt_set_id: dbId.nullable().optional(),
  /** Unsaved wording typed straight into the lab. `null` means "deliberately
   *  blank"; omit the field entirely to use whatever is saved in Settings. */
  template: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
});

/**
 * Write one email per model for one lead, and store them for judging.
 *
 * Nothing is sent and no campaign is touched — see lib/services/model-lab.ts
 * for how the carrier campaigns keep the real generator's behaviour intact.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");
  if (!user.companyId) return fail(400, "VALIDATION_ERROR", "No company on this account");

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const hasOverride = parsed.data.template !== undefined || parsed.data.prompt !== undefined;

  try {
    const { runGroup, emails } = await runLabComparison(db, {
      companyId: user.companyId,
      userId: user.id,
      leadId: parsed.data.lead_id,
      stepNumber: parsed.data.step_number,
      models: parsed.data.models,
      promptSetId: parsed.data.prompt_set_id ?? null,
      override: hasOverride
        ? { template: parsed.data.template, prompt: parsed.data.prompt }
        : undefined,
    });
    return ok({ run_group: runGroup, emails });
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}

/**
 * The most recent run for this lead + step + prompt set, with this person's
 * votes on it.
 *
 * Without this the screen lost everything on reload: the emails were safely in
 * model_lab_emails, but Compare held them only in React state, so a refresh
 * looked exactly like the run had never happened and invited paying for it
 * twice.
 */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");

  const url = new URL(req.url);
  const leadId = url.searchParams.get("lead_id");
  const stepNumber = Number(url.searchParams.get("step_number") ?? 1) || 1;
  const promptSetId = url.searchParams.get("prompt_set_id");
  if (!leadId) return fail(400, "VALIDATION_ERROR", "lead_id required");

  const db = dbForUser(user);
  let q = db.from("model_lab_emails")
    .select("id, run_group, model, label, subject, body, duration_ms, cost_usd, error, created_at")
    .eq("lead_id", leadId).eq("step_number", stepNumber)
    .order("created_at", { ascending: false }).limit(20);
  q = promptSetId ? q.eq("prompt_set_id", promptSetId) : q.is("prompt_set_id", null);

  const { data: rows } = await q;
  if (!rows?.length) return ok({ run_group: null, emails: [], votes: {} });

  // limit(20) may straddle two runs; keep only the newest one's rows.
  const runGroup = rows[0].run_group as string;
  const emails = rows.filter((r) => r.run_group === runGroup)
    .sort((a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")));

  const { data: votes } = await db.from("model_lab_votes")
    .select("email_id, verdict").eq("run_group", runGroup).eq("voted_by", user.id);

  return ok({
    run_group: runGroup,
    emails,
    votes: Object.fromEntries((votes ?? []).map((v) => [v.verdict as string, v.email_id as string])),
  });
}
