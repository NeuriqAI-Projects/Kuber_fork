// Which Organizations column / filter group a scored company belongs to, and
// the plain-words status shown for it. Pure, shared by the API and the UI.
import type { ProspectStatus } from "./pipeline";

export const GROUPS = ["checking", "review", "good", "approved", "declined", "hidden"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<Group, string> = {
  checking: "Checking", review: "Needs review", good: "Good fit", approved: "Approved", declined: "Declined", hidden: "Hidden",
};

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

/** One short line for a card or row: what is happening to this company right now. */
export function statusLine(r: GroupRow & { contact?: { first_name: string | null; title: string | null; email: string | null } | null }): { text: string; tone: Tone } {
  const retrying = (r.attempts ?? 0) > 0 && isWorking(r);
  if (retrying) return { text: `Retrying (try ${(r.attempts ?? 0) + 1} of 3) — ${r.last_error ?? "temporary error"}`, tone: "amber" };
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
    case "review": return { text: r.last_error ?? "AI unsure — your call", tone: "amber" };
    case "flagged": return { text: r.last_error ?? "Not enough information to check", tone: "amber" };
    case "site_down": return { text: r.last_error ?? "Website down", tone: "red" };
    case "rejected": return { text: "Declined", tone: "gray" };
    case "hidden": return { text: "Not a plastic maker", tone: "gray" };
    default: return { text: String(r.status), tone: "gray" };
  }
}
