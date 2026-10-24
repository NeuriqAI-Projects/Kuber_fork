// Plain words for the "Search started" screen (components/app/prospect-finder-form.tsx): the headline
// once a search is done, the Good-fit line and "Time left". Pure, so an outage or an Apollo credit
// stop can be tested to never read as "All companies checked" / "Good fits got their contact".

/** The parts of a search's numbers these lines read (GET /api/v1/prospects, `searches`). */
export interface ProgressNumbers {
  total: number;
  leads: number;
  groups: { good: number };
  stages: { read: number; read_failed: number; scored: number; score_failed: number; waiting_credits: number };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Companies whose website could not be read, and ones read but the AI gave no answer (score_failed counts both). */
export function failures(s: ProgressNumbers) {
  const unread = s.stages.read_failed;
  return { unread, aiFailed: Math.max(0, s.stages.score_failed - unread) };
}

/** Headline of a finished search: "All companies checked" only when every one was really checked. */
export function finishedHeadline(s: ProgressNumbers): { title: string; text: string; complete: boolean } {
  const { unread, aiFailed } = failures(s);
  const checked = s.stages.scored;
  const waiting = s.stages.waiting_credits;
  const contacts = `${plural(s.leads, "contact", "contacts")} revealed`;
  const credits = waiting > 0
    ? `${plural(waiting, "good fit is", "good fits are")} waiting for Apollo credits (they get their contact after a top-up); ${contacts} so far.`
    : null;
  if (checked >= s.total) {
    return { title: "All companies checked", complete: true, text: credits ?? `${contacts} at good fits; the rest wait in Organizations.` };
  }
  const why = [
    unread > 0 && `${plural(unread, "website", "websites")} could not be read`,
    aiFailed > 0 && `${plural(aiFailed, "company", "companies")} could not be checked by the AI`,
  ].filter(Boolean).join(" and ");
  return {
    title: `Finished: ${checked.toLocaleString()} of ${s.total.toLocaleString()} checked`,
    complete: false,
    text: `${why ? `${why.replace(/^./, (c) => c.toUpperCase())}. They wait in Needs review.` : "The rest wait in Needs review."}${credits ? ` ${credits.replace(/^./, (c) => c.toUpperCase())}` : ""}`,
  };
}

/** The "Good fits" row: what happens to them, and the numbers apart (found, revealed, waiting for credits). */
export function goodFitsLine(s: ProgressNumbers): { text: string; side: string } {
  const waiting = s.stages.waiting_credits;
  return {
    text: waiting > 0
      ? `${plural(waiting, "good fit is", "good fits are")} waiting for Apollo credits; the contact is revealed after a top-up`
      : "One contact revealed automatically, then it appears in Leads",
    side: `${s.groups.good.toLocaleString()} so far · ${plural(s.leads, "contact", "contacts")} revealed`,
  };
}

/** No progress for this long while work is left = something is down, not slow. */
export const STALL_MS = 2 * 60_000;

/** "Time left": a countdown only while companies really move; a stall says what it is waiting for. */
export function timeLeft(s: ProgressNumbers, done: boolean, stalledForMs: number, perMinute: number): { value: string; note: string } {
  if (done) return { value: "Done", note: " " };
  const left = Math.max(0, s.total - s.stages.scored - s.stages.score_failed);
  if (stalledForMs >= STALL_MS) {
    const { aiFailed } = failures(s);
    // Read but not scored yet (and not given up on) = waiting for the AI.
    const waitingForAi = s.stages.read - s.stages.scored - aiFailed > 0;
    return { value: "Retrying", note: waitingForAi ? "The AI is not answering; Kuber keeps retrying on its own." : "The websites are not answering; Kuber keeps retrying on its own." };
  }
  return { value: `~${Math.max(1, Math.ceil(left / perMinute))} min`, note: `about ${perMinute} companies a minute` };
}
