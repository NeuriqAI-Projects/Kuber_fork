// Which Organizations column / filter group a scored company belongs to, and
// the plain-words status shown for it. Pure, shared by the API and the UI
// (except scoredForOrg, a server-side read).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProspectStatus } from "./pipeline";

export const GROUPS = ["checking", "review", "good", "approved", "declined", "hidden"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<Group, string> = {
  checking: "Checking", review: "Needs review", good: "Good fit", approved: "Approved", declined: "Declined", hidden: "Hidden",
};

/** Window event with the latest review_total (useScoredOrgs fires it, the side-menu badge listens). */
export const REVIEW_TOTAL_EVENT = "kuber:scored-review-total";

export interface GroupRow {
  status: ProspectStatus | string;
  decided_by?: string | null;
  attempts?: number;
  last_error?: string | null;
  locked_until?: string | null;
}

/** After reveal starts, an approved company stays "Approved" (decided_by is set); an automatic one stays "Good fit". */
export function groupOf(r: GroupRow): Group {
  switch (r.status) {
    case "queued": case "read_social": case "read": return "checking";
    case "review": case "flagged": case "site_down": return "review";
    case "rejected": return "declined";
    case "hidden": return "hidden";
    case "approved": return "approved";
    default: return r.decided_by ? "approved" : "good"; // good, waiting_credits, no_contact, promoted
  }
}

/** Still being worked on by the background job (polling stays on while any exist). */
export const isWorking = (r: GroupRow) => ["queued", "read_social", "read", "good", "approved"].includes(r.status);

export type Tone = "blue" | "amber" | "green" | "red" | "gray";

/** A raw service error ("JEV_HTTP_503", "aborted due to timeout") in plain words, for "… because <this>".
 *  The raw text stays in last_error for the drawer's "Last error" detail. */
export function plainCause(raw: string | null | undefined): string {
  const e = raw ?? "";
  if (/JEV/i.test(e)) return "the AI that scores companies was not answering";
  if (/firecrawl/i.test(e)) return "the website reader was not answering";
  if (/timeout|timed out|aborted/i.test(e)) return "a service we use did not answer in time";
  if (/network|fetch failed|ECONN|ENOTFOUND|socket/i.test(e)) return "the connection to a service we use kept dropping";
  return "a service we use kept failing";
}

/** One short line for a card or row: what is happening to this company right now. */
export function statusLine(r: GroupRow & { contact?: { first_name: string | null; title: string | null; email: string | null } | null }): { text: string; tone: Tone } {
  const retrying = (r.attempts ?? 0) > 0 && isWorking(r);
  if (retrying) return { text: `Retrying (try ${(r.attempts ?? 0) + 1} of 3): ${plainCause(r.last_error)}. Nothing to do, it tries again on its own.`, tone: "amber" };
  switch (r.status) {
    case "queued": return { text: "Waiting to read website", tone: "blue" };
    case "read_social": return { text: "Website down — reading LinkedIn", tone: "blue" };
    case "read": return { text: "AI checking", tone: "blue" };
    case "good": case "approved": return { text: "Finding the right contact", tone: "blue" };
    case "waiting_credits": return { text: "Waiting for Apollo credits — continues after a top-up", tone: "amber" };
    case "no_contact": return { text: "No one with an email at this company", tone: "gray" };
    case "promoted":
      if (r.contact?.email) return { text: `Contact: ${[r.contact.first_name, r.contact.title].filter(Boolean).join(", ")}`, tone: "green" };
      return { text: "Contact added — revealing email", tone: "blue" };
    case "review":
      // pipeline.ts writes "Stopped after 3 tries: <raw error>" when a service kept failing.
      if (r.last_error?.startsWith("Stopped after")) return { text: `Could not be checked after 3 tries because ${plainCause(r.last_error)}. Approve or decline it yourself.`, tone: "amber" };
      // Search with job titles, nobody here has one (pipeline.ts): say what Approve does instead.
      if (r.last_error?.startsWith("No one with your job titles")) return { text: `${r.last_error}. Nothing was spent. Approve to reveal the best of them (1 credit), or decline.`, tone: "amber" };
      return { text: r.last_error ?? "AI unsure — your call", tone: "amber" };
    case "flagged": return { text: r.last_error ?? "Not enough information to check", tone: "amber" };
    case "site_down": return { text: "Website down: its website and social pages could not be read. Retry it later.", tone: "red" };
    case "rejected": return { text: "Declined", tone: "gray" };
    case "hidden": return { text: "Not a plastic maker", tone: "gray" };
    default: return { text: String(r.status), tone: "gray" };
  }
}

const SCORED_COLS = "id, search_id, name, domain, website_url, linkedin_url, status, score, reason, text_source, last_error, attempts, locked_until, decided_by, organization_id, contact_apollo_id";

/** The scored-search row that found an organization, in the same shape as a company of
 *  GET /api/v1/prospects (group, batch name/colour, revealed contact), or null when the
 *  org did not come from a scored search. `db` must be company-scoped; `leads` are the
 *  org's leads (the revealed contact is one of them). */
export async function scoredForOrg(db: SupabaseClient, orgId: string, leads: { apollo_id?: string | null; first_name: string | null; title: string | null; email: string | null }[]) {
  const { data: pc } = await db.from("prospect_companies").select(SCORED_COLS)
    .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!pc) return null;
  const { data: search } = await db.from("prospect_searches").select("filters").eq("id", pc.search_id).maybeSingle();
  const f = (search?.filters ?? {}) as { batch_name?: string; color?: string };
  const l = pc.contact_apollo_id ? leads.find((x) => x.apollo_id === pc.contact_apollo_id) : null;
  return {
    ...pc, group: groupOf(pc), batch_name: f.batch_name ?? "Scored search", batch_color: f.color ?? "green",
    contact: l ? { first_name: l.first_name, title: l.title, email: l.email } : null,
  };
}
