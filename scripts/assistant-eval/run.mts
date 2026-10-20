/**
 * Kuber AI eval suite.
 *
 *   npx tsx --env-file=.env.local scripts/assistant-eval/run.mts            # all cases
 *   npx tsx --env-file=.env.local scripts/assistant-eval/run.mts E03 E19    # some cases
 *   ... run.mts --no-judge                                                   # skip the LLM judge
 *
 * Runs real questions through the real agent against the Dev company, checks
 * each answer against numbers computed straight from the database, asserts
 * that action cases changed nothing, and has a strong model grade the answer.
 * Writes docs/assistant-evals/latest.md and latest.json.
 *
 * Spends AI tokens on the Dev company's own keys (a few cents a run).
 * Never calls Apollo or Instantly: action cases stop at the confirm card.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createScopedClient } from "../../lib/supabase/scoped.ts";
import { createAdminClient } from "../../lib/supabase/admin.ts";
import { getThreads } from "../../lib/services/unibox.ts";
import { MAX_ENRICH_ATTEMPTS } from "../../lib/services/enrich-leads.ts";
import { DEV, USERS, judge, loadEvalUsers, runConversation, type TurnResult } from "./harness.mts";
import { makeCases, type Check, type EvalCase, type GroundTruth } from "./cases.mts";

const args = process.argv.slice(2);
const only = args.filter((a) => /^E\d+$/.test(a));
const deepOnly = args.includes("--deep");
const useJudge = !args.includes("--no-judge");
const CONCURRENCY = 3;
/** Compare models: EVAL_FAST_MODEL=claude-sonnet-5-5 runs every Fast case on that Anthropic model. */
const FAST_MODEL = process.env.EVAL_FAST_MODEL;
/** Same for Deep cases: EVAL_DEEP_MODEL=claude-sonnet-5-5. */
const DEEP_MODEL = process.env.EVAL_DEEP_MODEL;
const TAG = process.env.EVAL_TAG ?? "latest";
/** Pass bar for the judge (1-5). */
const JUDGE_PASS = 4;

const db = createScopedClient(DEV);

async function count(table: string, f: (q: any) => any = (q) => q): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { count, error } = await f(db.from(table).select("id", { count: "exact", head: true }));
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function groundTruth(): Promise<GroundTruth> {
  const notDeleted = (q: any) => q.eq("is_deleted", false); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [totalLeads, enriched, inputRequired] = await Promise.all([
    count("leads", notDeleted),
    count("leads", (q) => notDeleted(q).eq("status", "enriched")),
    count("leads", (q) => notDeleted(q).eq("status", "input_required")),
  ]);
  const notInCampaign = (extra: (q: any) => any = (q) => q) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let q = db.from("leads").select("id, campaign_leads!lead_id(id)", { count: "exact", head: true })
      .eq("is_deleted", false).eq("status", "enriched").is("campaign_leads", null);
    q = extra(q);
    return q.then((r: { count: number | null }) => r.count ?? 0);
  };
  const [enrichedNotInCampaign, enrichedNotInCampaignIndia] = await Promise.all([
    notInCampaign(),
    notInCampaign((q) => q.ilike("country", "%India%")),
  ]);
  const { data: indiaRows } = await db.from("leads")
    .select("id, email, organizations(unsubscribed), campaign_leads!lead_id(id)")
    .eq("is_deleted", false).eq("status", "enriched").ilike("country", "%India%").is("campaign_leads", null).limit(2000);
  const indiaCampaignReady = (indiaRows ?? []).filter((l) => {
    const org = Array.isArray(l.organizations) ? l.organizations[0] : l.organizations;
    return !!l.email && !(org as { unsubscribed?: boolean } | null)?.unsubscribed;
  }).length;
  const { data: paused } = await db.from("campaigns").select("name").eq("is_deleted", false).eq("status", "paused");
  const employeeLeads = await count("leads", (q) => notDeleted(q).eq("assigned_to", USERS.employee.id));
  const draftsWaiting = await count("email_drafts", (q) => q.eq("status", "draft"));
  const needsReply = (await getThreads(db, { read_state: "needs_reply", limit: 1 })).counts.total;
  const { data: assigned } = await db.from("leads").select("assigned_to").eq("is_deleted", false).not("assigned_to", "is", null).limit(10000);
  const tally = new Map<string, number>();
  for (const r of assigned ?? []) tally.set(r.assigned_to as string, (tally.get(r.assigned_to as string) ?? 0) + 1);
  const topId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const { data: topProfile } = await db.from("profiles").select("full_name").eq("id", topId ?? "").maybeSingle();
  const revealCandidates = await count("leads", (q) => notDeleted(q).eq("lead_source", "apollo").is("email", null).lt("enrich_attempts", MAX_ENRICH_ATTEMPTS));
  return {
    totalLeads, enriched, inputRequired, enrichedNotInCampaign, enrichedNotInCampaignIndia, indiaCampaignReady,
    pausedCampaigns: (paused ?? []).map((p) => p.name as string),
    employeeLeads, draftsWaiting, needsReply,
    topAssignee: ((topProfile?.full_name as string | null) ?? "").split(" ")[0],
    revealCandidates,
    ...(await subjects()),
  };
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const fullName = (l: { first_name: string | null; last_name: string | null }) => [l.first_name, l.last_name].filter(Boolean).join(" ");

/**
 * The people, companies and campaigns the cases ask about, chosen from the Dev
 * data at run time. Real names and emails are never written into this repo.
 */
async function subjects(): Promise<Pick<GroundTruth,
  "lead360" | "threadEmail" | "ambiguousName" | "org" | "repliedCampaign" | "activeCampaign" | "otherTeammate" | "otherEmployeeLead" | "foreignLeadId">> {
  // A lead who replied: has a company and a campaign, so "everything about X" has something to say.
  const { data: replied } = await db.from("campaign_leads")
    .select("last_reply_at, campaigns(name), leads!lead_id!inner(id, first_name, last_name, email, is_deleted, organizations(name))")
    .not("last_reply_at", "is", null).eq("leads.is_deleted", false)
    .order("last_reply_at", { ascending: false }).limit(20);
  const pick = (replied ?? []).map((r) => ({
    lead: one(r.leads as never) as { first_name: string | null; last_name: string | null; email: string | null; organizations: unknown } | null,
    campaign: (one(r.campaigns as never) as { name: string } | null)?.name ?? null,
  })).find((r) => r.lead && fullName(r.lead) && one(r.lead.organizations as never) && r.campaign);
  if (!pick?.lead) throw new Error("Need a lead with a reply, a company and a campaign in the Dev data.");
  const lead360 = { name: fullName(pick.lead), company: (one(pick.lead.organizations as never) as { name: string }).name, campaign: pick.campaign! };

  const { data: received } = await db.from("unibox_emails").select("lead_email").eq("direction", "received").not("lead_email", "is", null)
    .order("timestamp_email", { ascending: false }).limit(1);
  const threadEmail = (received?.[0]?.lead_email as string) ?? pick.lead.email!;

  // A full name several leads share — the "which one?" case.
  const { data: names } = await db.from("leads").select("first_name, last_name").eq("is_deleted", false).not("first_name", "is", null).limit(5000);
  const tally = new Map<string, number>();
  for (const n of names ?? []) { const k = fullName(n); if (k.includes(" ")) tally.set(k, (tally.get(k) ?? 0) + 1); }
  const ambiguousName = [...tally.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] ?? lead360.name;

  // A company with at least two leads.
  const { data: orgs } = await db.from("organizations").select("name, leads(first_name, last_name, is_deleted)").limit(400);
  const orgPick = (orgs ?? [])
    .map((o) => ({ name: o.name as string, leads: ((o.leads ?? []) as Array<{ first_name: string | null; last_name: string | null; is_deleted: boolean }>).filter((l) => !l.is_deleted && l.first_name) }))
    .filter((o) => o.name && o.leads.length >= 2)
    .sort((a, b) => b.leads.length - a.leads.length)[0];
  const org = { name: orgPick?.name ?? lead360.company, leadFirstNames: (orgPick?.leads ?? []).map((l) => l.first_name!) };

  const { data: camps } = await db.from("campaigns").select("name, status, sent_count, replied_count").eq("is_deleted", false);
  const repliedCampaign = (camps ?? []).filter((c) => (c.replied_count ?? 0) > 0).sort((a, b) => (b.sent_count ?? 0) - (a.sent_count ?? 0))[0];
  const activeCampaign = (camps ?? []).find((c) => c.status === "active" && c.name !== repliedCampaign?.name);

  const { data: team } = await db.from("profiles").select("id, full_name").neq("id", USERS.employee.id).neq("id", USERS.manager.id);
  const otherTeammate = ((team?.[0]?.full_name as string | null) ?? "a teammate").split(" ")[0];
  const otherId = team?.[0]?.id as string | undefined;
  const { data: theirs } = otherId
    ? await db.from("leads").select("first_name, last_name, email, organizations(name)").eq("assigned_to", otherId).eq("is_deleted", false).not("email", "is", null).limit(1)
    : { data: [] };
  const t = theirs?.[0];
  const otherEmployeeLead = t ? { name: fullName(t), company: (one(t.organizations as never) as { name: string } | null)?.name ?? "", email: t.email as string } : null;

  const { data: foreign } = await createAdminClient().from("leads").select("id").neq("company_id", DEV).limit(1);
  return {
    lead360, threadEmail, ambiguousName, org,
    repliedCampaign: { name: repliedCampaign?.name as string, sent: repliedCampaign?.sent_count ?? 0, replied: repliedCampaign?.replied_count ?? 0 },
    activeCampaign: (activeCampaign?.name as string) ?? "",
    otherTeammate, otherEmployeeLead,
    foreignLeadId: (foreign?.[0]?.id as string) ?? "00000000-0000-0000-0000-000000000001",
  };
}

/** Row counts that no read or proposal may change. */
async function snapshot(): Promise<Record<string, number>> {
  const [campaigns, campaignLeads, comments, replyDrafts, unassigned, paused, llmDrafts] = await Promise.all([
    count("campaigns"),
    count("campaign_leads"),
    count("lead_comments"),
    count("reply_drafts"),
    count("leads", (q) => q.is("assigned_to", null)),
    count("campaigns", (q) => q.eq("status", "paused")),
    count("email_drafts"),
  ]);
  return { campaigns, campaignLeads, comments, replyDrafts, unassigned, paused, llmDrafts };
}

type CaseResult = {
  id: string; skill: string; who: string; mode: string; provider: string | null; model: string | null;
  question: string; answer: string; tools: string[];
  checks: Check[]; judge: { score: number; reason: string } | null;
  ttftMs: number | null; totalMs: number; costUsd: number;
  pass: boolean; error: string | null;
};

async function runCase(c: EvalCase): Promise<CaseResult> {
  let turns: TurnResult[] = [];
  let error: string | null = null;
  try {
    const override = c.mode === "fast" ? FAST_MODEL : DEEP_MODEL;
    const pin = c.pin ?? (override ? { provider: "anthropic" as const, model: override } : undefined);
    turns = await runConversation({ who: c.who, mode: c.mode, turns: c.turns, pin });
  } catch (e) {
    error = (e as Error).message;
  }
  const last = turns[turns.length - 1];
  const checks = last ? c.checks(last, turns) : [{ name: "ran", pass: false, detail: error ?? "no result" }];
  if (last?.error) checks.push({ name: "no stream error", pass: false, detail: last.error });
  let j: { score: number; reason: string; costUsd: number } | null = null;
  if (useJudge && last) {
    try {
      j = await judge({ who: c.who, question: c.turns.join("\n→ "), rubric: c.rubric, answer: last.text, tools: last.tools });
    } catch (e) {
      j = { score: 0, reason: `judge failed: ${(e as Error).message}`, costUsd: 0 };
    }
  }
  const checksPass = checks.every((k) => k.pass);
  return {
    id: c.id, skill: c.skill, who: c.who, mode: c.mode,
    provider: last?.provider ?? null, model: last?.model ?? null,
    question: c.turns.join(" → "), answer: last?.text ?? "",
    tools: (last?.tools ?? []).map((t) => `${t.name}(${JSON.stringify(t.input)})`),
    checks, judge: j ? { score: j.score, reason: j.reason } : null,
    ttftMs: last?.ttftMs ?? null,
    totalMs: last?.totalMs ?? 0,
    costUsd: turns.reduce((s, t) => s + (t.costUsd ?? 0), 0) + (j?.costUsd ?? 0),
    pass: checksPass && (!j || j.score >= JUDGE_PASS),
    error: error ?? last?.error ?? null,
  };
}

function pct(n: number, d: number) { return d ? `${Math.round((n / d) * 100)}%` : "–"; }
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

async function main() {
  const started = Date.now();
  await loadEvalUsers();
  console.log("Computing ground truth from the database…");
  const gt = await groundTruth();
  const cases = makeCases(gt).filter((c) => (!only.length || only.includes(c.id)) && (!deepOnly || c.mode === "deep"));
  const before = await snapshot();

  const results: CaseResult[] = [];
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const c = cases[next++];
      const r = await runCase(c);
      results.push(r);
      const failed = r.checks.filter((k) => !k.pass).map((k) => k.name);
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.skill} [${r.mode}] ${(r.totalMs / 1000).toFixed(1)}s` +
        `${r.judge ? ` judge=${r.judge.score}` : ""}${failed.length ? ` ✗ ${failed.join("; ")}` : ""}${r.judge && r.judge.score < JUDGE_PASS ? ` — ${r.judge.reason}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

  const after = await snapshot();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);

  const fast = results.filter((r) => r.mode === "fast");
  const deep = results.filter((r) => r.mode === "deep");
  const passed = results.filter((r) => r.pass).length;
  const allChecks = results.flatMap((r) => r.checks);
  const judged = results.filter((r) => r.judge);
  const summary = {
    ran_at: new Date().toISOString(),
    cases: results.length,
    passed,
    pass_rate: pct(passed, results.length),
    checks_passed: `${allChecks.filter((k) => k.pass).length}/${allChecks.length}`,
    judge_avg: judged.length ? Math.round((judged.reduce((s, r) => s + (r.judge?.score ?? 0), 0) / judged.length) * 100) / 100 : null,
    fast_ttft_p50_s: quantile(fast.map((r) => r.ttftMs ?? r.totalMs), 0.5) / 1000,
    fast_total_p50_s: quantile(fast.map((r) => r.totalMs), 0.5) / 1000,
    fast_total_p90_s: quantile(fast.map((r) => r.totalMs), 0.9) / 1000,
    deep_total_p50_s: quantile(deep.map((r) => r.totalMs), 0.5) / 1000,
    cost_usd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
    database_unchanged: changed.length === 0,
    database_changes: changed.map((k) => `${k}: ${before[k]} → ${after[k]}`),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
  };

  mkdirSync("docs/assistant-evals", { recursive: true });
  writeFileSync(`docs/assistant-evals/${TAG}.json`, JSON.stringify({ summary, ground_truth: gt, results }, null, 2));

  const md: string[] = [];
  md.push(`# Kuber AI — eval report`, "");
  md.push(`Ran ${summary.ran_at} on the Dev company. Re-run: \`npx tsx --env-file=.env.local scripts/assistant-eval/run.mts\`.`, "");
  md.push(`| Metric | Result |`, `|---|---|`);
  md.push(`| Cases passed | **${passed}/${results.length}** (${summary.pass_rate}) |`);
  md.push(`| Deterministic checks | ${summary.checks_passed} |`);
  md.push(`| Judge average (1–5) | ${summary.judge_avg ?? "skipped"} |`);
  md.push(`| Fast: first output p50 | ${summary.fast_ttft_p50_s.toFixed(1)} s |`);
  md.push(`| Fast: full answer p50 / p90 | ${summary.fast_total_p50_s.toFixed(1)} s / ${summary.fast_total_p90_s.toFixed(1)} s |`);
  md.push(`| Deep: full answer p50 | ${summary.deep_total_p50_s.toFixed(1)} s |`);
  md.push(`| Database unchanged by reads/proposals | ${summary.database_unchanged ? "yes" : `**NO** — ${summary.database_changes.join(", ")}`} |`);
  md.push(`| Total cost (answers + judge) | $${summary.cost_usd} |`, "");
  md.push(`| Case | Skill | Who | Mode | Model | Time | Judge | Result |`, `|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    md.push(`| ${r.id} | ${r.skill} | ${r.who} | ${r.mode} | ${r.model ?? "–"} | ${(r.totalMs / 1000).toFixed(1)}s | ${r.judge?.score ?? "–"} | ${r.pass ? "✅" : "❌"} |`);
  }
  md.push("", "## Details", "");
  for (const r of results) {
    md.push(`### ${r.id} — ${r.skill} ${r.pass ? "✅" : "❌"}`, "");
    md.push(`**Q:** ${r.question}`, "");
    md.push(`**Tools:** ${r.tools.length ? r.tools.map((t) => `\`${t.slice(0, 160)}\``).join(", ") : "none"}`, "");
    md.push(`**Checks:** ${r.checks.map((k) => `${k.pass ? "✓" : "✗"} ${k.name}${!k.pass && k.detail ? ` (${k.detail.slice(0, 120)})` : ""}`).join(" · ")}`, "");
    if (r.judge) md.push(`**Judge ${r.judge.score}/5:** ${r.judge.reason}`, "");
    md.push("**Answer:**", "", r.answer.split("\n").map((l) => `> ${l}`).join("\n"), "");
  }
  writeFileSync(`docs/assistant-evals/${TAG}.md`, md.join("\n"));

  console.log("\n" + JSON.stringify(summary, null, 2));
  process.exit(summary.database_unchanged ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
