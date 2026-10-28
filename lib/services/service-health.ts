import { classifyFallback } from "@/lib/services/fallback-reason";

// The rules behind the service-health banner (/api/v1/service-health), kept
// here so they can be checked without a database: service-health.test.ts.
const PROFILES = "Company profiles AI";

// "warning" = degraded but still functioning (a fallback is covering the gap);
// "critical" = the capability is actually down. Drives banner color (amber vs red).
export type ServiceIssue = { service: string; kind: "credits" | "auth"; message: string; severity: "warning" | "critical" };

export type HealthLogRow = { source: string | null; event: string | null; error: string | null; payload?: unknown };

/** rows: enrichment_logs from the lookback window, NEWEST FIRST. */
export function issuesFromLogs(rows: HealthLogRow[]): ServiceIssue[] {
  const issues: ServiceIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: ServiceIssue) => {
    if (seen.has(issue.service)) return;
    seen.add(issue.service);
    issues.push(issue);
  };

  for (const row of rows) {
    const err = (row.error ?? "").toLowerCase();

    // Instantly's copy of a sequence no longer matches ours. Not a credit or
    // auth problem, but it belongs here for the same reason the others do: it
    // is an upstream disagreement nobody would otherwise notice, and the last
    // one ran for weeks and stopped every follow-up 2 from being sent.
    // "warning" rather than "critical" — mail is still going out, just on the
    // wrong schedule.
    if (row.event === "SEQUENCE_DRIFT") {
      add({
        service: "Follow-up schedule",
        kind: "auth",
        message: row.error
          ?? "A campaign's follow-up timing in Instantly no longer matches this app.",
        severity: "warning",
      });
      continue;
    }

    // Severity is derived from which event actually fired, not re-guessed
    // from env vars — with 6 possible LLM tiers (Settings > Keys), a fixed
    // "is OPENAI_API_KEY set" check can no longer tell whether a fallback is
    // actually covering the gap. scrape-orgs/route.ts already did that work
    // and logged the outcome; this just surfaces it.
    //
    // The two company-profile rows (fallback warning, skipped critical) share
    // one slot, so the newest of them wins over a stale one.
    //
    // Success rows: a newer "it works again" row claims its slot with no issue,
    // so an older error below it is skipped. Without these every banner stayed
    // up for the whole 6h lookback after a top-up / key fix (28 Oct 2026).
    // Drafts ("LLM API key") and company profiles ("Company profiles AI") have
    // separate slots: sharing one let a newer amber profiles warning hide a
    // red "drafts are paused".
    if (row.event === "DRAFT_LLM_RECOVERED") { seen.add("LLM API key"); continue; }
    if (row.event === "SCRAPE_BATCH_STARTED") {
      // Only logged after the credit gate passed: Firecrawl and an LLM tier are usable.
      seen.add("Firecrawl");
      if ((row.payload as { primary_llm_ok?: boolean } | null)?.primary_llm_ok === true) seen.add(PROFILES);
      continue;
    }
    if (row.source === "firecrawl" && row.event === "SCRAPE_SUCCESS") { seen.add("Firecrawl"); continue; }
    if (row.source === "apollo" && row.event === "CREDITS_CONSUMED") { seen.add("Apollo"); continue; }
    if (row.event === "PRIMARY_LLM_LOW_CREDITS_FALLBACK_ACTIVE") {
      add({ service: PROFILES, kind: "credits", severity: "warning", message: row.error ?? "" });
    } else if (row.event === "SKIPPED_LOW_CREDITS") {
      // One skip row can name either cause, or both.
      if (err.includes("no usable llm provider")) {
        add({
          service: PROFILES,
          kind: "credits",
          severity: "critical",
          message: "No configured LLM provider can generate company profiles right now — add or top up a key in Credits.",
        });
      }
      if (err.includes("firecrawl")) {
        add({ service: "Firecrawl", kind: "credits", severity: "critical", message: "Firecrawl is out of credits — company websites can't be read. Top up or update the Firecrawl API key." });
      }
      continue;
    } else if (row.event === "DRAFT_LLM_UNAVAILABLE") {
      // Drafts have their own branch because the two rules above are worded for
      // company profiles, and because an OpenRouter 402 carries neither the
      // word "openai" nor a code the next rule matches — so a drafts outage on
      // that key alone would have shown nothing at all.
      // Worded for BOTH audiences on purpose: this banner is not gated by role
      // (dashboard, leads, campaigns list and campaign detail all render it),
      // and an employee cannot open Settings > Keys — telling them to go there
      // would be the only instruction they are unable to follow.
      // The reason matters. This branch used to say "Out of credits" whatever
      // had actually gone wrong, so a key returning 401 Missing Authentication
      // sent someone to top up an account that had money in it. Seen live
      // 28 Aug 2026 on a freshly added OpenRouter key.
      const why = classifyFallback(row.error);
      add({
        service: "LLM API key",
        kind: why.code === "bad_key" ? "auth" : "credits",
        severity: "critical",
        message: why.code === "bad_key"
          ? "The AI provider is rejecting the API key, so email drafts are paused. A manager needs to check or replace it in Credits — this is not a billing problem."
          : why.code === "service_busy"
            ? "The AI provider is temporarily unavailable, so email drafts are paused. This usually clears on its own; drafting resumes automatically."
            : "Out of credits — email drafts are paused and no new ones will be generated. A manager needs to top up or replace the key in Credits.",
      });
    } else if (row.source === "llm" && err.includes("openai") && (err.includes("401") || err.includes("403") || err.includes("insufficient_quota") || err.includes("429"))) {
      add({ service: "OpenAI", kind: "credits", severity: "critical", message: "OpenAI is rejecting requests — check its API key / billing." });
    }
    // The Firecrawl low-credit skip message ("Firecrawl is out of credits (N
    // left)") has neither "402" nor "insufficient" in it — match "credit" too.
    if (row.source === "firecrawl" && (err.includes("402") || err.includes("insufficient") || err.includes("credit"))) {
      add({ service: "Firecrawl", kind: "credits", severity: "critical", message: "Firecrawl is out of credits — company websites can't be read. Top up or update the Firecrawl API key." });
    }
    // Apollo email-reveal (people/bulk_match) returns 422 "insufficient credits"
    // on most plans and 402 on others — enrich logs CREDITS_EXHAUSTED for both.
    // Without this branch the leads page just showed New forever with no banner.
    if (row.event === "CREDITS_EXHAUSTED" || (row.source === "apollo" && (err.includes("insufficient credits") || err.includes("credits exhausted")))) {
      add({
        service: "Apollo",
        kind: "credits",
        severity: "critical",
        message: "Apollo is out of lead credits — imported contacts can't get emails revealed. Top up credits or update the Apollo key in Credits.",
      });
    } else if (row.source === "apollo" && (err.includes("401") || err.includes("403"))) {
      add({ service: "Apollo", kind: "auth", severity: "critical", message: "Apollo rejected the API key — lead emails can't be revealed. Update the Apollo master key." });
    }
  }

  return issues;
}
