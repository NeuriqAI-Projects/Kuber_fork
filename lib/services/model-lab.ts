import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { generateOneDraft, type LabOverride } from "@/lib/services/generate-drafts";
import { htmlToPlainText } from "@/lib/utils/email-html";

/**
 * Model Lab — trying a model, or a prompt, on real leads without sending
 * anything.
 *
 * The one rule this service exists to keep: a lab email must be written by
 * EXACTLY the code that writes a real one, or the comparison says nothing about
 * production. So it calls generateOneDraft rather than reimplementing the
 * prompt assembly, and pays for that with the awkwardness below — a hidden
 * carrier campaign per model, and a draft row that is read and then deleted.
 *
 * ponytail: carrier campaigns are the cheap way to reuse the generator whole.
 * The clean version extracts prompt assembly from generateOneDraft into a pure
 * function both paths call; worth doing if the lab ever needs to diverge.
 */

/** Candidates the client is choosing between. Claude Sonnet 4.6 and GPT-5.4
 *  mini are deliberately absent: both are already trusted, and reading time
 *  spent on them proves nothing. */
export const LAB_MODELS = [
  "google/gemini-3.5-flash-lite",
  "deepseek/deepseek-v3.2",
  "openai/gpt-5.6-luna",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "qwen/qwen3-14b",
  "openai/gpt-oss-120b",
] as const;

export const BENCH_LEADS_KEY = "model_lab_bench_leads";
export const LAB_MODELS_KEY = "model_lab_models";
/** Hidden carrier campaigns are named with this prefix and kept out of every
 *  campaign list by is_deleted — see labCampaignFor(). */
const LAB_CAMPAIGN_PREFIX = "[model lab] ";

export type LabEmail = {
  id: string;
  model: string;
  label: string | null;
  subject: string | null;
  body: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  error: string | null;
};

async function settingJson<T>(db: SupabaseClient, key: string): Promise<T | null> {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  const raw = (data?.value as string | null)?.trim();
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function getBenchLeadIds(db: SupabaseClient): Promise<string[]> {
  return (await settingJson<string[]>(db, BENCH_LEADS_KEY)) ?? [];
}

export async function getLabModels(db: SupabaseClient): Promise<string[]> {
  const saved = await settingJson<string[]>(db, LAB_MODELS_KEY);
  return saved?.length ? saved : [...LAB_MODELS];
}

export async function setSetting(db: SupabaseClient, key: string, value: unknown): Promise<void> {
  await db.from("settings").upsert(
    { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
    { onConflict: "key" },   // matches every other settings upsert in the app
  );
}

/**
 * The hidden campaign this model writes its lab emails through.
 *
 * One per model, not one overall: uq_email_drafts_campaign_lead_step allows a
 * single live draft per (campaign, lead, step), so seven models writing for the
 * same lead at the same moment would collide on a shared campaign and six of
 * them would fail.
 *
 * Created with is_deleted = true, which is what keeps it out of the Campaigns
 * list, the dashboard and every count — nothing in the generator reads that
 * flag, so the draft path itself behaves exactly as it does for a real one.
 */
async function labCampaignFor(
  db: SupabaseClient,
  model: string,
  userId: string | null,
  leadIds: string[],
): Promise<string> {
  const name = `${LAB_CAMPAIGN_PREFIX}${model}`;
  const { data: existing } = await db
    .from("campaigns").select("id").eq("name", name).maybeSingle();

  let campaignId = existing?.id as string | undefined;
  if (!campaignId) {
    const { data: created, error } = await db.from("campaigns").insert({
      name,
      status: "draft",
      is_deleted: true,
      human_in_loop: true,
      followups_ai_enabled: true,
      created_by: userId,
      signature_user_id: userId,
      created_at: new Date().toISOString(),
    }).select("id").single();
    if (error || !created) throw new Error(error?.message ?? "Could not create the lab campaign");
    campaignId = created.id as string;
  }

  // Bench membership can change between runs; add whatever is missing.
  const { data: present } = await db
    .from("campaign_leads").select("lead_id").eq("campaign_id", campaignId);
  const have = new Set((present ?? []).map((r) => r.lead_id as string));
  const missing = leadIds.filter((id) => !have.has(id));
  if (missing.length) {
    await db.from("campaign_leads").insert(missing.map((lead_id) => ({
      campaign_id: campaignId, lead_id, crm_status: "enriched",
      created_by: userId, created_at: new Date().toISOString(),
    })));
  }
  return campaignId;
}

const LEAD_SELECT = `
  id, lead_id, attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
  leads!lead_id!inner(id, first_name, last_name, email, title, headline, seniority, city, country, assigned_to,
    organizations(name, domain, website, industry, employees, city, country, company_description, sells_to, keywords))`;

/** Blind labels in run order: Email A, Email B, … */
const labelFor = (i: number) => String.fromCharCode(65 + i);

/**
 * Write one email per model for one lead and step, and store them.
 *
 * Models run in parallel — each has its own carrier campaign, so they cannot
 * collide — and one model failing never stops the rest: its row is stored with
 * the error, because "this model could not do it" is a result worth seeing next
 * to six that could.
 */
export async function runLabComparison(
  db: SupabaseClient,
  opts: {
    companyId: string;
    userId: string | null;
    leadId: string;
    stepNumber: number;
    models: string[];
    promptSetId?: string | null;
    override?: { template?: string | null; prompt?: string | null };
  },
): Promise<{ runGroup: string; emails: LabEmail[] }> {
  const runGroup = randomUUID();
  const now = new Date().toISOString();

  const results = await Promise.all(opts.models.map(async (model, i) => {
    const started = Date.now();
    const row = {
      company_id: opts.companyId,
      run_group: runGroup,
      lead_id: opts.leadId,
      step_number: opts.stepNumber,
      model,
      prompt_set_id: opts.promptSetId ?? null,
      label: labelFor(i),
      created_by: opts.userId,
      created_at: now,
    };

    try {
      const campaignId = await labCampaignFor(db, model, opts.userId, [opts.leadId]);
      const { data: cl } = await db
        .from("campaign_leads").select(LEAD_SELECT)
        .eq("campaign_id", campaignId).eq("lead_id", opts.leadId).maybeSingle();
      if (!cl) throw new Error("Lead is not on the bench");

      const labOverride: LabOverride = {
        model,
        provider: "openrouter",
        ...(opts.override ?? {}),
      };

      const result = await generateOneDraft(
        db, cl as never, campaignId, opts.companyId,
        true,                      // human_in_loop: a lab draft is never auto-approved
        `Model Lab · ${model}`,
        opts.userId ?? undefined,
        undefined, undefined, undefined,
        opts.stepNumber,
        undefined, undefined,
        labOverride,
      );

      if (!result.ok) {
        return { ...row, duration_ms: Date.now() - started, error: result.reason.slice(0, 400) };
      }

      // Read the draft, then take it out of the campaign entirely. The lab owns
      // its own copy; leaving the draft behind would let a later bench change
      // sweep a lab email into something real.
      //
      // The pointer has to be cleared first: generateOneDraft repoints
      // campaign_leads.draft_id at a step-1 draft, and campaign_leads_draft_id_fkey
      // then refuses the delete. That refusal was swallowed on the first live
      // run and left one row behind per model per run — hence the explicit
      // error check below, so a silent regression is impossible.
      const { data: draft } = await db
        .from("email_drafts").select("subject, body").eq("id", result.draftId).maybeSingle();
      await db.from("campaign_leads").update({ draft_id: null })
        .eq("campaign_id", campaignId).eq("lead_id", opts.leadId);
      const { error: delErr } = await db.from("email_drafts").delete().eq("id", result.draftId);
      if (delErr) console.error(`model-lab: lab draft ${result.draftId} not removed — ${delErr.message}`);

      return {
        ...row,
        subject: (draft?.subject as string | null) ?? null,
        body: (draft?.body as string | null) ?? null,
        duration_ms: Date.now() - started,
        error: null,
      };
    } catch (e) {
      return { ...row, duration_ms: Date.now() - started, error: (e as Error).message.slice(0, 400) };
    }
  }));

  const { data: saved, error } = await db.from("model_lab_emails").insert(results)
    .select("id, model, label, subject, body, duration_ms, cost_usd, error");
  if (error) throw new Error(error.message);

  // Cost is recorded by complete() against the carrier campaign, so it is read
  // back rather than guessed. Best effort: a missing figure is a blank cell, not
  // a failed run.
  await attachCosts(db, runGroup, opts.models).catch(() => {});

  return { runGroup, emails: (saved ?? []) as LabEmail[] };
}

/** Copy each model's spend for this run out of llm_usage and onto its row. */
async function attachCosts(db: SupabaseClient, runGroup: string, models: string[]): Promise<void> {
  const { data: rows } = await db
    .from("model_lab_emails").select("id, model, created_at").eq("run_group", runGroup);
  if (!rows?.length) return;
  const since = new Date(Date.parse(rows[0].created_at as string) - 60_000).toISOString();

  const { data: usage } = await db
    .from("llm_usage").select("model, cost_usd, created_at")
    .gte("created_at", since).in("model", models);

  for (const row of rows) {
    const match = (usage ?? []).filter((u) => u.model === row.model);
    if (!match.length) continue;
    const cost = match.reduce((a, u) => a + Number(u.cost_usd ?? 0), 0) / match.length;
    await db.from("model_lab_emails").update({ cost_usd: cost }).eq("id", row.id);
  }
}

/** Wins, losses and averages per model, split by prompt set — a score earned
 *  under one wording must never be read as a score under another. */
export async function getScoreboard(db: SupabaseClient): Promise<Array<{
  prompt_set_id: string | null;
  prompt_set_name: string;
  model: string;
  best: number;
  worst: number;
  runs: number;
  avg_ms: number | null;
  avg_cost: number | null;
}>> {
  const { data: emails } = await db
    .from("model_lab_emails")
    .select("id, model, prompt_set_id, duration_ms, cost_usd, run_group, error");
  const { data: votes } = await db.from("model_lab_votes").select("email_id, verdict");
  const { data: sets } = await db.from("model_lab_prompt_sets").select("id, name");

  const setName = new Map((sets ?? []).map((s) => [s.id as string, s.name as string]));
  const best = new Set<string>(), worst = new Set<string>();
  const bestCount = new Map<string, number>(), worstCount = new Map<string, number>();
  for (const v of votes ?? []) {
    const id = v.email_id as string;
    if (v.verdict === "best") { best.add(id); bestCount.set(id, (bestCount.get(id) ?? 0) + 1); }
    else { worst.add(id); worstCount.set(id, (worstCount.get(id) ?? 0) + 1); }
  }

  const acc = new Map<string, { best: number; worst: number; runs: number; ms: number[]; cost: number[] }>();
  for (const e of emails ?? []) {
    if (e.error) continue;
    const key = `${e.prompt_set_id ?? ""}|${e.model}`;
    const bucket = acc.get(key) ?? { best: 0, worst: 0, runs: 0, ms: [], cost: [] };
    bucket.runs++;
    bucket.best += bestCount.get(e.id as string) ?? 0;
    bucket.worst += worstCount.get(e.id as string) ?? 0;
    if (e.duration_ms != null) bucket.ms.push(Number(e.duration_ms));
    if (e.cost_usd != null) bucket.cost.push(Number(e.cost_usd));
    acc.set(key, bucket);
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...acc.entries()].map(([key, v]) => {
    const [setId, model] = key.split("|");
    return {
      prompt_set_id: setId || null,
      prompt_set_name: setId ? (setName.get(setId) ?? "Deleted prompt set") : "Live settings",
      model, best: v.best, worst: v.worst, runs: v.runs,
      avg_ms: mean(v.ms), avg_cost: mean(v.cost),
    };
  }).sort((a, b) => b.best - a.best || a.worst - b.worst);
}

/** Plain text of an email, for the Formatted / Plain toggle. */
export const labPlainText = (html: string | null) => (html ? htmlToPlainText(html) : "");
