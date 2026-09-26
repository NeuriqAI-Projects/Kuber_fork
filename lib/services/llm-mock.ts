import type { SupabaseClient } from "@supabase/supabase-js";
import { DEV_COMPANY_ID } from "@/lib/constants";
import { sleep } from "@/lib/http";

/**
 * Fake AI for UI testing on fake data.
 *
 * Lets the team walk through every drafting state in the real app (writing,
 * failed, out of credits, default email, sending) without one AI credit or one
 * real email. On only for campaigns in the internal Dev workspace whose name
 * starts with "[TEST]", so it can never touch the client: the company check is
 * the gate, the name is the opt-in.
 *
 * Words in the campaign name pick the scenario:
 *   "no-credits"       — the AI is out of credits from the start
 *   "credits-run-out"  — credits run out once half the leads are written
 *   "slow"             — each draft takes 20s, so "still writing" can be seen
 * And per lead: an email containing "aifail" gets a broken answer every time.
 *
 * Test campaigns are also kept out of production's background jobs (see
 * isMockCampaign's callers): they never get draft_generation_started_at and
 * have AI follow-ups off, which is what those jobs select on.
 */
export function isMockCampaign(companyId: string | null | undefined, campaignName: string | null | undefined): boolean {
  return companyId === DEV_COMPANY_ID && /^\s*\[TEST\]/i.test(campaignName ?? "");
}

export const MOCK_PRIMARY = "Claude Sonnet (test)";
export const MOCK_BACKUP = "GPT 5.4-mini (test)";

const CREDIT_ERROR = "Your credit balance is too low to access the Anthropic API (mock)";

/** Would the fake AI answer right now? Mirrors "is the main key usable". */
export async function mockAiAvailable(db: SupabaseClient, campaignId: string | null, campaignName: string): Promise<boolean> {
  if (/no-credits/i.test(campaignName)) return false;
  if (!/credits-run-out/i.test(campaignName) || !campaignId) return true;
  // Finished emails only. Counting in-flight ('generating') rows made the
  // answer flip: six in flight tipped it to "out", the calls failed, the rows
  // turned 'failed', the count dropped back and it read "available" again, so
  // the Drafting-paused bar flashed on and off (UI test, 26 Sep 2026). And once
  // a call has been refused it stays refused, the way a real empty key stays
  // dead until someone tops up and presses Re-check.
  const [{ count: total }, { count: written }, { count: refused }] = await Promise.all([
    db.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
    db.from("email_drafts").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).eq("step_number", 1).in("status", ["draft", "approved", "sent"]),
    db.from("email_drafts").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).eq("status", "failed").like("rejection_reason", "%credit balance%(mock)%"),
  ]);
  return (refused ?? 0) === 0 && (written ?? 0) < Math.ceil((total ?? 0) / 2);
}

/** Stand-in for the model's answer. Throws the same errors a real call would. */
export async function mockDraftCompletion(
  db: SupabaseClient,
  campaignId: string,
  campaignName: string,
  lead: { first_name?: string | null; email?: string | null; organizations?: unknown },
): Promise<{ subject: string; body: string; product_match: string }> {
  await sleep(/slow/i.test(campaignName) ? 20_000 : 2_500);
  if (!(await mockAiAvailable(db, campaignId, campaignName))) throw new Error(CREDIT_ERROR);
  if (/aifail/i.test(lead.email ?? "")) throw new Error("Draft shape mismatch — body: Required (mock)");

  const org = (Array.isArray(lead.organizations) ? lead.organizations[0] : lead.organizations) as { name?: string } | null;
  const company = org?.name ?? "your company";
  return {
    subject: `Masterbatch supply for ${company} | Kuber Polyplast`,
    product_match: "White Masterbatch",
    body: [
      `Dear ${lead.first_name ?? "Sir/Ma'am"},`,
      `I'm reaching out from Kuber Polyplast, an ISO 9001:2015 certified Indian manufacturer with 30 years of experience in masterbatches and specialty compounds.`,
      `I came across ${company} and your work in flexible packaging. Our **White Masterbatch** gives consistent opacity at low dosing, which suits high-speed film lines.`,
      `[TEST EMAIL written by the fake AI, no credits used.] Would you be open to a short call next week to see if it fits your current films?`,
    ].join("\n\n"),
  };
}
