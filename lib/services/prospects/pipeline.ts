// Company-first scoring pipeline: read → score → (reveal one contact).
//
// Each prospect row moves ONE stage per `advance()` call, and every stage ends
// in exactly one `store.save()`. A crash, timeout or Vercel kill before that
// save leaves the row in its old status; its lock expires and the stage runs
// again. That's what makes a stage all-or-nothing from our side.
//
// Paid calls get special care, because "the provider charged us but we never
// saved" can't be undone:
//   • Firecrawl (1 credit) is the only paid call in its stage, and its result
//     is saved the moment it returns, so a retry never pays for the page twice.
//   • The Apollo email reveal is not made here at all. Promotion only inserts
//     one lead (has_email, no email); the existing reveal job buys it, with
//     its own out-of-credits handling. Promotion first checks that Apollo has
//     a credit to spare for it, so we never queue reveals we can't pay for.
// Jev and Tavily calls cost fractions of a cent and are safe to repeat.
import { displayScore, reasonFor, verdict, type FitScoring } from "./fit-rules";
import type { JevVerdict } from "./jev";
import { cleanText, htmlToText, linksFromMarkdown, pickSecondPage, sitemapLocs, wordCount } from "./text";
import { pickBestContact } from "../lead-ranking";

export type ProspectStatus =
  | "queued"          // waiting to be read
  | "read_social"     // website down/empty; try LinkedIn/Twitter/Facebook next
  | "read"            // text saved, waiting to be scored
  | "good"            // a plastic maker, will reveal one contact
  | "approved"        // client approved from Review, will reveal one contact
  | "waiting_credits" // good/approved, but Apollo has no credit free right now
  | "review"          // client decides (unsure, over auto limit, or failed 3 times)
  | "hidden"          // not a plastic maker
  | "flagged"         // nothing to score from (no website, no LinkedIn, or LinkedIn too thin/unsure)
  | "site_down"       // website down and no social page; client decides whether to retry
  | "no_contact"      // good company, but Apollo has nobody with an email there
  | "promoted"        // one lead created; the reveal job takes it from here
  | "rejected";       // client said no

export const WORKABLE: ProspectStatus[] = ["queued", "read_social", "read", "good", "approved", "waiting_credits"];

export interface ProspectRow {
  id: string;
  search_id: string;
  apollo_org_id: string;
  name: string;
  domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  status: ProspectStatus;
  page_text: string | null;
  page_markdown: string | null;
  text_source: string | null;
  attempts: number;
}

export type ProspectPatch = Partial<{
  status: ProspectStatus;
  page_text: string | null;
  page_markdown: string | null;
  text_source: string | null;
  score: number | null;
  score_confidence: number | null;
  reason: string | null;
  extra_sources: string[];
  jev_tokens: number;
  auto_reveal: boolean;
  attempts: number;
  last_error: string | null;
  organization_id: string | null;
  contact_apollo_id: string | null;
  /** epoch ms; the row is skipped until then. Omitted = unlock now. */
  retry_at: number | null;
}>;

export interface Person {
  id: string; title: string | null; has_email: boolean;
  first_name?: string | null; city?: string | null; state?: string | null; country?: string | null;
}

export type HomeRead = { kind: "ok"; markdown: string } | { kind: "site_down"; detail: string };

/** Every outside service. Real ones in deps.ts, fakes in the tests. Throwing = transient, retry. */
export interface Deps {
  now(): number;
  /** Firecrawl, 1 credit. site_down = the website itself failed; throw = Firecrawl/our side failed.
   *  Must throw OutOfTime instead of starting the paid call after `startBy` (epoch ms). */
  readHome(url: string, startBy: number): Promise<HomeRead>;
  /** Free GET; null on any failure. */
  freeGet(url: string): Promise<string | null>;
  tavilyExtract(url: string): Promise<string>;
  tavilySearch(query: string): Promise<string>;
  /** Jev's two yes/no answers for this company (keywords come from the row's search). */
  score(row: ProspectRow, text: string): Promise<JevVerdict>;
  /** Apollo credits free for NEW reveals (balance minus reveals already queued). null = unknown, proceed. */
  apolloCreditsFree(): Promise<number | null>;
  findPeople(apolloOrgId: string): Promise<Person[]>;
  /** Create (or find) the organization + one lead. Must be idempotent. Returns organization id. */
  promote(row: ProspectRow, person: Person): Promise<string>;
}

export interface Store {
  /** Lock and return up to `limit` workable rows whose lock/retry time has passed. */
  claim(limit: number): Promise<ProspectRow[]>;
  /** Write the patch and release the lock (or set it to patch.retry_at). */
  save(id: string, patch: ProspectPatch): Promise<void>;
  /** Atomically take one automatic-reveal slot for this search. false = the search's cap
   *  (its own, else `defaultCap`) is already used up. Must be safe under parallel callers. */
  reserveAutoReveal(searchId: string, defaultCap: number): Promise<boolean>;
}

/** A paid call was not started because the run is about to end. Not a failure:
 *  the company is released untouched for the next run, no try used up. */
export class OutOfTime extends Error {
  constructor() { super("out of time for a paid call in this run"); }
}

export const MAX_ATTEMPTS = 3;
const MIN_WORDS = 20;
const WAIT_FOR_CREDITS_MS = 10 * 60_000;
const backoffMs = (attempt: number) => attempt * 2 * 60_000;

export async function advance(row: ProspectRow, deps: Deps, store: Store, cfg: FitScoring, startBy = Infinity): Promise<void> {
  try {
    const patch = await stage(row, deps, store, cfg, startBy);
    await store.save(row.id, { ...patch, attempts: patch.attempts ?? 0, retry_at: patch.retry_at ?? null });
  } catch (err) {
    if (err instanceof OutOfTime) { await store.save(row.id, {}); return; }
    const msg = (err as Error).message?.slice(0, 500) ?? "unknown error";
    const attempts = row.attempts + 1;
    await store.save(
      row.id,
      attempts >= MAX_ATTEMPTS
        ? { status: "review", attempts, last_error: `Stopped after ${attempts} tries: ${msg}`, retry_at: null }
        : { attempts, last_error: msg, retry_at: deps.now() + backoffMs(attempts) },
    );
  }
}

async function stage(row: ProspectRow, deps: Deps, store: Store, cfg: FitScoring, startBy: number): Promise<ProspectPatch> {
  switch (row.status) {
    case "queued": return readStage(row, deps, startBy);
    case "read_social": return socialStage(row, deps);
    case "read": return scoreStage(row, deps, store, cfg);
    case "good": case "approved": case "waiting_credits": return promoteStage(row, deps);
    default: throw new Error(`not workable: ${row.status}`);
  }
}

const socials = (row: ProspectRow) => [row.linkedin_url, row.twitter_url, row.facebook_url].filter((u): u is string => !!u);

async function readStage(row: ProspectRow, deps: Deps, startBy: number): Promise<ProspectPatch> {
  const site = row.website_url || (row.domain ? `https://${row.domain}` : null);
  if (!site) return socialStage(row, deps); // no paid call yet, safe to do in this stage

  const home = await deps.readHome(site, startBy); // the one paid call; saved right after
  if (home.kind === "ok") {
    const text = cleanText(home.markdown);
    if (wordCount(text) >= MIN_WORDS) {
      return { status: "read", page_text: text, page_markdown: home.markdown.slice(0, 100_000), text_source: "website", last_error: null };
    }
  }
  const why = home.kind === "site_down" ? home.detail : "website has almost no text";
  return socials(row).length
    ? { status: "read_social", last_error: why }
    : { status: "site_down", last_error: why };
}

async function socialStage(row: ProspectRow, deps: Deps): Promise<ProspectPatch> {
  const urls = socials(row);
  if (!urls.length) {
    // Website was there but down → the client decides. Never had one → nothing to go on.
    return row.website_url || row.domain
      ? { status: "site_down" }
      : { status: "flagged", last_error: "No website and no LinkedIn" };
  }
  for (const url of urls) {
    const text = cleanText(await deps.tavilyExtract(url));
    if (wordCount(text) >= MIN_WORDS) {
      return { status: "read", page_text: text, text_source: url.includes("linkedin") ? "linkedin" : "social", last_error: null };
    }
  }
  return { status: "flagged", last_error: "Social page says too little to score" };
}

async function scoreStage(row: ProspectRow, deps: Deps, store: Store, cfg: FitScoring): Promise<ProspectPatch> {
  const text = row.page_text ?? "";
  let v = await deps.score(row, text);
  let tokens = v.input_tokens;
  const extras: string[] = [];
  const unsure = () => verdict(v.plastic, cfg) === "unsure";

  // Only when Jev can't tell whether it's a plastic maker: the About page (free),
  // then a web search (Tavily). Stop at the first one that settles it.
  if (unsure() && row.text_source === "website") {
    // Free, but capped at 12 s so a slow site can't hold up the run.
    const about = await Promise.race([freeSecondPage(row, deps), new Promise<null>((r) => setTimeout(() => r(null), 12_000))]);
    if (about) {
      v = await deps.score(row, `${text}

--- ${about.url}
${about.text}`);
      tokens += v.input_tokens; extras.push(about.url);
    }
    if (unsure()) {
      const found = await deps.tavilySearch(`${row.name} ${row.domain ?? ""} company products`.trim()).catch(() => "");
      if (wordCount(found) >= MIN_WORDS) {
        v = await deps.score(row, `${text}

--- What other websites say:
${found}`);
        tokens += v.input_tokens; extras.push("tavily_search");
      }
    }
  }

  const scored = {
    score: displayScore(v.plastic, v.on_target, cfg),
    score_confidence: v.plastic,
    reason: reasonFor(v.plastic, v.on_target, cfg),
    jev_tokens: tokens, extra_sources: extras, last_error: null,
  };
  const decided = verdict(v.plastic, cfg);

  // LinkedIn-only text that leaves the AI unsure is flagged, not reviewed (decided 8 Oct 2026).
  if (decided === "unsure" && row.text_source !== "website") return { ...scored, status: "flagged", last_error: "Unsure from the LinkedIn page alone" };
  if (decided === "hidden") return { ...scored, status: "hidden" };
  if (decided === "unsure") return { ...scored, status: "review" };
  // One atomic step, so parallel lanes can never overshoot the cap. If we crash
  // after taking a slot, that slot is simply lost: fewer reveals, never more.
  if (!(await store.reserveAutoReveal(row.search_id, cfg.max_auto_reveals_per_search))) {
    return { ...scored, status: "review", last_error: "Good fit, but this search already used all its automatic reveals" };
  }
  return { ...scored, status: "good", auto_reveal: true };
}

async function freeSecondPage(row: ProspectRow, deps: Deps): Promise<{ url: string; text: string } | null> {
  const home = row.website_url || (row.domain ? `https://${row.domain}` : null);
  if (!home) return null;
  let origin: string;
  try { origin = new URL(home).origin; } catch { return null; }

  const urls: string[] = [];
  for (const p of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]) {
    const xml = await deps.freeGet(origin + p);
    if (!xml || !/<loc>/i.test(xml)) continue;
    const locs = sitemapLocs(xml);
    for (const sub of locs.filter((u) => /\.xml(\?|$)/i.test(u)).slice(0, 3)) urls.push(...sitemapLocs((await deps.freeGet(sub)) ?? ""));
    urls.push(...locs);
    break;
  }
  const page = pickSecondPage(origin + "/", urls) ?? pickSecondPage(origin + "/", linksFromMarkdown(row.page_markdown ?? "", origin + "/"));
  if (!page) return null;
  const html = await deps.freeGet(page);
  const text = html ? cleanText(htmlToText(html)) : "";
  return wordCount(text) >= MIN_WORDS ? { url: page, text } : null;
}

async function promoteStage(row: ProspectRow, deps: Deps): Promise<ProspectPatch> {
  const free = await deps.apolloCreditsFree();
  if (free !== null && free < 1) {
    // Not a failure: no attempt is used up. Checked again every 10 minutes.
    return { status: "waiting_credits", attempts: row.attempts, last_error: "Apollo has no credits free for a reveal", retry_at: deps.now() + WAIT_FOR_CREDITS_MS };
  }
  const people = (await deps.findPeople(row.apollo_org_id)).filter((p) => p.has_email);
  const best = pickBestContact(people);
  if (!best) return { status: "no_contact", last_error: "Apollo has no one with an email at this company" };
  const orgId = await deps.promote(row, best);
  return { status: "promoted", organization_id: orgId, contact_apollo_id: best.id, last_error: null };
}

/** One worker run: `lanes` loops side by side, each taking the next company the
 *  moment it finishes (no waiting for the slowest of a batch). No lane starts a
 *  new stage once the time budget is spent; a stage already running may overrun
 *  it, and if the platform kills us there the lock expires and that stage
 *  repeats (safe, see the header). Paid-call concurrency (Firecrawl) is capped
 *  inside deps, not here. */
export async function runBatch(deps: Deps, store: Store, cfg: FitScoring, opts: { budgetMs: number; lanes: number; paidStartMs?: number }) {
  const start = deps.now();
  const timeLeft = () => deps.now() - start < opts.budgetMs;
  // Latest moment a paid read may START (it can take ~15 s and must finish before the function is stopped).
  const startBy = start + (opts.paidStartMs ?? opts.budgetMs);
  let advanced = 0;
  async function lane() {
    while (timeLeft()) {
      const [row] = await store.claim(1);
      if (!row) return;
      await advance(row, deps, store, cfg, startBy);
      advanced++;
    }
  }
  await Promise.all(Array.from({ length: opts.lanes }, lane));
  return { advanced };
}
