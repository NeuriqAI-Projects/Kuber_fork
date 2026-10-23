"use client";

// Add leads › Scored Companies: the 4-step search wizard. After Search it shows
// "Search started" with live numbers; the companies themselves are reviewed in
// the Organizations view (components/app/scored-orgs.tsx), not in this drawer.
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle, Check, CircleAlert, Loader2, Search, X } from "lucide-react";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { TagInput } from "@/components/app/tag-input";
import { buildAdvanced, CompanyAdvancedSearch } from "@/components/app/company-lookup-form";
import { JobTitlesPicker } from "@/components/app/apollo-people-advanced";
import {
  AssignStrategyPicker, BatchNameField, buildImportAssignment, clearDraft, IndustryKeywordsDropdown, useDraft,
  useAssignableEmployees, useIndustryKeywordGroups, type ImportAssignMode,
} from "@/components/app/lead-forms";
import { api, checkedDone, leadsCount, type ApiError, type ScoredSearch } from "@/components/app/scored-orgs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { InfoTip } from "@/components/ui/info-tip";
import { Label } from "@/components/ui/label";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { Stepper } from "@/components/ui/stepper";
import { Pill } from "@/components/ui/pill";
import type { BatchColorName } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { FIRECRAWL_PER_PAGE, LEADS_PER_PAGE, MAX_LEADS_PER_SEARCH, MAX_PAGES_PER_SEARCH, minCredits, suggestedMaxCredits } from "@/lib/services/prospects/digging";
import { noLeadsLeft } from "@/lib/services/prospects/estimate";

const STEPS = ["Criteria", "Settings", "Batch", "Assign"];
const SIZE_SUGGESTIONS = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,10000"];
/** Leads asked for by default. */
const DEFAULT_TARGET = 100;
const TARGET_CHIPS = [50, 100, 200, 500];
/** Measured live on 17 Oct 2026 with only the every-minute background job. */
const COMPANIES_PER_MINUTE = 20;

interface MarketEstimate {
  companies: { low: number; mid: number; high: number };
  leads: { low: number; high: number };
  pages_used?: number; total_pages?: number | null;
  leads_left?: { low: number; high: number };
  /** Most leads the Apollo / Firecrawl balances can pay for (null = unknown). */
  fits?: { apollo_leads: number | null; firecrawl_leads: number | null; apollo_credits?: number | null; firecrawl_credits?: number | null };
}
type Fits = NonNullable<MarketEstimate["fits"]>;

/** The "bill" beside step 2: what a lead target is expected to cost, from the
 *  17 Oct 2026 live tests: about 33 leads per 100 companies, 1 Apollo credit
 *  per lead + 1 per page of 100 companies, never more than the limit. */
function Bill({ target, maxCredits, firecrawlShort, size, jobTitles }: { target: number; maxCredits: number; firecrawlShort: boolean; size: SizeVerdict; jobTitles: number }) {
  const pages = Math.ceil(target / LEADS_PER_PAGE);
  const expected = minCredits(target);
  const minutes = Math.max(1, Math.round((pages * 100) / COMPANIES_PER_MINUTE));
  const line = "flex justify-between gap-3 tabular-nums";
  // The size check says there is (almost) nothing to find: a bill for the full target would promise leads.
  if (size) {
    return (
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-4 text-[13px]">
        <p className="text-[15px] font-semibold">Your search</p>
        <p className="text-muted-foreground">
          {size === "none-left"
            ? "Nothing new to find with these filters, so nothing would be spent."
            : "Expect few or no leads: these keywords match almost no companies. A search costs 1 credit per 100 companies found, and 1 per lead only if a lead is found."}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card p-4 text-[13px]">
      <p className="text-[15px] font-semibold">Your search</p>
      <div className={line}><span>{target} lead{target === 1 ? "" : "s"} × 1 credit</span><span>{target}</span></div>
      <div className={line}><span>~{pages} page{pages === 1 ? "" : "s"} of 100 companies (most {MAX_PAGES_PER_SEARCH})</span><span>{pages}</span></div>
      <div className={cn(line, "border-t border-dashed border-border pt-2 text-sm font-semibold")}><span className="flex items-center gap-1">Expected <InfoTip side="left" text="Companies that aren't plastic makers, or have nobody to email, cost nothing." /></span><span>~{expected} credits</span></div>
      <div className={cn(line, maxCredits < expected ? "font-semibold text-destructive" : "text-muted-foreground")}><span>Your limit</span><span>{maxCredits.toLocaleString()} credit{maxCredits === 1 ? "" : "s"}</span></div>
      {jobTitles > 0 && <p className="text-xs text-muted-foreground">Your job titles can lower the number of automatic leads: companies with nobody of those titles wait in Needs review (free).</p>}
      <div className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
        <div className={cn(line, firecrawlShort && "font-semibold text-destructive")}><span>Website reading</span><span>~{pages * FIRECRAWL_PER_PAGE} Firecrawl</span></div>
        <div className={line}><span>Time (in the background)</span><span>~{minutes} min</span></div>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="mt-1 w-full">View detailed bill</Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg rounded-lg">
          <DialogHeader><DialogTitle>Detailed bill</DialogTitle></DialogHeader>
          <div className="space-y-4 text-[13px]">
            <section className="space-y-1.5">
              <p className="font-medium text-foreground">Apollo credits</p>
              <div className={line}><span>Searching: {pages} × 100 companies</span><span>{pages}</span></div>
              <p className="text-xs text-muted-foreground">Apollo charges 1 credit for every page of 100 companies. About 1 in {Math.round(100 / LEADS_PER_PAGE)} companies becomes a lead, so {target} leads need ~{pages} pages.</p>
              <div className={line}><span>Lead contacts: {target} × 1</span><span>{target}</span></div>
              <p className="text-xs text-muted-foreground">Each good-fit company gets one buyer revealed. Apollo charges 1 credit per revealed contact.</p>
              <div className={cn(line, "border-t border-dashed border-border pt-1.5 font-semibold")}><span>Expected</span><span>~{expected}</span></div>
              <div className={cn(line, maxCredits < expected && "font-semibold text-destructive")}><span>Your limit (Kuber never goes over)</span><span>{maxCredits.toLocaleString()}</span></div>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium text-foreground">Firecrawl credits</p>
              <div className={cn(line, firecrawlShort && "font-semibold text-destructive")}><span>Website reading: {pages} × 100 companies</span><span>~{pages * FIRECRAWL_PER_PAGE}</span></div>
              <p className="text-xs text-muted-foreground">Kuber reads each company&apos;s website (1 Firecrawl credit each) so the AI can tell if it makes plastic products.</p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium text-foreground">Costs nothing</p>
              <p className="text-xs text-muted-foreground">The free size check, companies that aren&apos;t plastic makers (Hidden), and companies with nobody to email. Needs-review companies cost 1 Apollo credit only when you approve them.</p>
            </section>
            <div className={line}><span>Time (in the background)</span><span>~{minutes} min</span></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** What the size check says about finding anything: every page read before, or almost no companies. */
type SizeVerdict = "none-left" | "almost-none" | null;

/** Free size check (Apollo People Search, 0 credits): is there enough for the lead target? */
function MarketSize({ filters, target, onPick, onFits, onSize }: { filters: Record<string, unknown> & { keywords: string[] }; target: number; onPick: (n: number) => void; onFits: (f: Fits | null | undefined) => void; onSize: (v: SizeVerdict) => void }) {
  const [est, setEst] = useState<MarketEstimate | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const key = JSON.stringify(filters);
  useEffect(() => {
    // Only a finished check may block Next; loading, failed or no keywords never do (the server still refuses).
    onSize(null);
    if (!filters.keywords.length) { setEst(null); setState("idle"); onFits(null); return; }
    let alive = true;
    setState("loading"); onFits(undefined);
    let t: ReturnType<typeof setTimeout>;
    // A busy server or a slow Apollo often answers on the next try: keep "Checking…" for 2 more tries before saying it failed.
    const attempt = (tries: number) => {
      api<MarketEstimate>("/api/v1/prospects/estimate", filters)
        .then((e) => {
          if (!alive) return;
          const left = e.leads_left ?? e.leads;
          setEst(e); setState("idle"); onFits(e.fits ?? null);
          onSize(noLeadsLeft(e) ? "none-left" : e.companies.mid === 0 || left.high === 0 ? "almost-none" : null);
        })
        .catch(() => { if (!alive) return; if (tries < 2) t = setTimeout(() => attempt(tries + 1), 2000); else { setState("error"); onFits(null); } });
    };
    t = setTimeout(() => attempt(0), 600);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!filters.keywords.length) return null;
  const n = (x: number) => x.toLocaleString();
  const left = est?.leads_left ?? est?.leads;
  const used = est?.pages_used ?? 0;
  // The low end is what the keywords can surely give; the client asks for one number, so we answer with one.
  const tooFew = !!left && left.low > 0 && target > left.low;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px]">
        {state === "loading" ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="size-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          {state === "error" && <span className="text-muted-foreground">Couldn&apos;t check the size. You can still search.</span>}
          {state !== "error" && !est && <span className="text-muted-foreground">Checking available leads…</span>}
          {state !== "error" && est && (
            est.companies.mid === 0
              ? <span className="font-medium text-amber-700 dark:text-amber-300">Almost no companies for these keywords.</span>
              : left!.high === 0
                ? <span className="font-medium text-amber-700 dark:text-amber-300">{used > 0 ? "No new leads left for these keywords." : "Almost no leads for these keywords."}</span>
                : <span>Available: <b className="font-semibold tabular-nums">~{n(left!.low)} leads</b> <span className="text-muted-foreground">(up to {n(left!.high)})</span></span>
          )}
        </div>
        <InfoTip side="left" text={`Free check, no credits used. A rough guess. A lead = a plastic maker with a person we can email (about 1 in 3 companies). Your keywords match about ${est ? n(est.companies.mid) : "…"} companies in Apollo.${used > 0 ? " You searched them before, so companies you already got are skipped." : ""}`} />
      </div>
      {est && est.companies.mid > 0 && tooFew && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1.5">
            <p>Only about <b className="font-semibold tabular-nums">{n(left!.low)}</b> leads available. Add keywords or countries in step 1 for more.</p>
            <Button type="button" size="sm" variant="outline" onClick={() => onPick(left!.low)}>Ask for {n(left!.low)} leads instead</Button>
          </div>
        </div>
      )}
    </div>
  );
}


/** "Search started": live numbers for the search just launched, and where to go next. */
function Started({ searchId, batchName, batchColor, onOpen, onAnother }: {
  searchId: string; batchName: string; batchColor: string; onOpen: () => void; onAnother: () => void;
}) {
  const [s, setS] = useState<ScoredSearch | null>(null);
  // false until the first answer: after it, no `s` = the search is not among the 20 most recent any more.
  const [loaded, setLoaded] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const kicking = useRef(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const d = await api<{ searches: ScoredSearch[] }>("/api/v1/prospects?summary=1");
        const mine = d.searches.find((x) => x.id === searchId) ?? null;
        if (!alive) return;
        setS(mine); setLoaded(true); setNetError(null);
        // On a laptop there's no minute pump; nudge the background job while there's work.
        if (mine && mine.in_progress > 0 && !kicking.current) {
          kicking.current = true;
          api("/api/v1/prospects/run", {}).catch(() => {}).finally(() => { kicking.current = false; });
        }
      } catch (e) { if (alive) setNetError((e as Error).message); }
    }
    void tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [searchId]);

  const total = s?.total ?? 0;
  // Really scored by the AI; the ones it gave up on are counted apart, never as "checked".
  const checked = s?.stages.scored ?? 0;
  const failed = s?.stages.score_failed ?? 0;
  const left = Math.max(0, total - (s ? checkedDone(s) : 0));
  const done = !!s && s.in_progress === 0;
  const gone = loaded && !s;
  const none = done && total === 0;
  const tile = "flex flex-col gap-1 rounded-lg border border-border bg-card p-4";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 py-2">
      <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {done || gone ? <Check className="size-5" /> : <Loader2 className="size-5 animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold">{gone ? "Search finished" : none ? "No companies found" : done ? "All companies checked" : "Search started"}</p>
          <p className="text-sm text-muted-foreground">
            {gone ? "It is no longer among your 20 most recent searches. Open Organizations to see its companies."
              : none ? (s?.run_note ?? s?.error ?? "Apollo found no new companies for these filters. Add other keywords or countries.")
              : done ? (failed > 0 ? `Done. ${failed} compan${failed === 1 ? "y" : "ies"} could not be checked; they wait in Needs review.` : "Good fits got their contact; the rest wait in Organizations.")
              : "Kuber is checking every company in the background. You can close this window — nothing stops."}
          </p>
        </div>
        <Pill color={batchColor as BatchColorName} dot className="shrink-0">{batchName}</Pill>
      </div>

      {s?.target_leads != null && !none && (
        <div className="space-y-1.5 rounded-lg border border-border bg-card p-4">
          <p className="text-sm"><b className="text-[15px] font-semibold tabular-nums">{leadsCount(s)}</b>
            <span className="text-muted-foreground"> · {s.pages.length} page{s.pages.length === 1 ? "" : "s"} of 100 companies read{s.pages.length ? ` (page ${s.pages.join(", ")})` : ""}</span>
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${Math.min(100, (s.leads / s.target_leads) * 100)}%` }} /></div>
          {s.run_note && <p className={cn("text-sm", s.leads < s.target_leads ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")}>{s.run_note}</p>}
          {!!s.job_titles?.length && <p className="text-xs text-muted-foreground">Only people with these job titles are revealed: {s.job_titles.join(", ")}.</p>}
          {!s.run_note && s.run_status === "running" && <p className="text-xs text-muted-foreground">Kuber reads the next 100 companies on its own when these are checked, until it has {s.target_leads} leads or hits your credit limit.</p>}
        </div>
      )}

      {netError && <p className="flex items-center gap-1.5 text-[13px] text-amber-700 dark:text-amber-300"><CircleAlert className="size-4" /><span title={netError}>Can&apos;t reach the server right now.</span> The search keeps running; these numbers update when the connection is back.</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Companies found</span>
          <span className="text-2xl font-semibold tabular-nums">{s?.returned ?? "…"}</span>
          <span className="text-xs text-muted-foreground">{s ? `${s.total} new to you` : " "}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Checked by the AI</span>
          <span className="text-2xl font-semibold tabular-nums">{checked}<span className="text-sm font-normal text-muted-foreground">/{total}</span></span>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${total ? (checked / total) * 100 : 0}%` }} />
            {failed > 0 && <div className="h-full bg-red-400 transition-[width] duration-500 dark:bg-red-500/70" style={{ width: `${(failed / total) * 100}%` }} />}
          </div>
          {failed > 0 && <span className="text-xs font-medium tabular-nums text-red-600 dark:text-red-400">{failed} could not be checked</span>}
          {!!s?.stages.read_failed && <span className="text-xs tabular-nums text-muted-foreground">{s.stages.read} websites read · {s.stages.read_failed} could not be read</span>}
        </div>
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Time left</span>
          <span className="text-2xl font-semibold tabular-nums">{done || gone ? "Done" : `~${Math.max(1, Math.ceil(left / COMPANIES_PER_MINUTE))} min`}</span>
          <span className="text-xs text-muted-foreground">about {COMPANIES_PER_MINUTE} companies a minute</span>
        </div>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
        {[
          { icon: <Check className="size-4" />, tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", title: "Good fits", text: "One contact revealed automatically, then it appears in Leads", side: s ? `${s.groups.good} so far` : "" },
          { icon: <CircleAlert className="size-4" />, tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", title: "Need your review", text: "Approve or decline them in Organizations", side: s ? `${s.groups.review} so far · no cost until approved` : "" },
          { icon: <X className="size-4" />, tone: "bg-secondary text-muted-foreground", title: "Not a fit", text: "Traders, distributors, machine makers — hidden", side: s ? `${s.groups.hidden} · nothing spent` : "" },
        ].map((r) => (
          <div key={r.title} className="flex items-center gap-3 py-3">
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", r.tone)}>{r.icon}</span>
            <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{r.title}</p><p className="text-xs text-muted-foreground">{r.text}</p></div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.side}</span>
          </div>
        ))}
      </div>

      {s && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-[13px]">
          <b className="font-semibold tabular-nums">Apollo credits used so far: {s.credits_used}</b>{s.max_credits != null ? ` of your limit of ${s.max_credits.toLocaleString()}` : ""} ({s.credits_spent} for search{s.credits_spent === 1 ? "" : "es"} + {s.credits_used - s.credits_spent} contact{s.credits_used - s.credits_spent === 1 ? "" : "s"}){s.mock ? " · test batch, nothing is charged" : ""}.
          <span className="text-muted-foreground"> Website reading: about {s.stages.read} Firecrawl credits.</span>
        </p>
      )}

      {s && s.stages.waiting_credits > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">
          Apollo ran out of credits: {s.stages.waiting_credits} good compan{s.stages.waiting_credits === 1 ? "y is" : "ies are"} waiting. They continue on their own after a top-up — nothing is lost.
        </p>
      )}

      {/* Sticks to the bottom of the dialog's scroll area: the screen grows (leads box, notes) and
          the buttons were cut off below the fold. Same pattern as the lead drawer's footer. */}
      <div className="sticky -bottom-5 -mb-7 flex justify-center gap-2 border-t border-border bg-background pb-5 pt-3">
        <Button type="button" onClick={onOpen}>Open in Organizations →</Button>
        <Button type="button" variant="outline" onClick={onAnother}>Start another search</Button>
      </div>
    </div>
  );
}

/** A dropped connection reads "TypeError: fetch failed" / "Failed to fetch"; say what it means. */
function friendlyError(msg: string): string {
  return /fetch failed|failed to fetch|networkerror/i.test(msg)
    ? "Lost the connection while contacting Apollo or the database, so the search did not finish. Check your internet and try again. If your Apollo credits went down, the search may have gone through: look for the batch in Organizations."
    : msg;
}

type StartedInfo = { searchId: string; batchName: string; color: string };
type StartOutcome = { ok: true; started: StartedInfo } | { ok: false; error: string };

/**
 * The search being started, and the screen that follows it, must outlive the form.
 *
 * Closing the modal unmounts the form but cannot cancel the request (Apollo still charges for it),
 * and a reload or a dev hot-reload throws away anything held only in memory. Without this, reopening
 * gave a blank Criteria step (finishing clears the draft) with no sign a search was running or had
 * started, so people searched again and paid twice.
 *   `starting`   the running request, in memory: a reopened form waits on it
 *   KEY_START    a marker in the tab's session storage: survives a reload; the form then looks the
 *                new search up by its batch name
 *   KEY_RESULT   the answer ("search started" or the error), kept until the person dismisses it
 */
let starting: { batchName: string; promise: Promise<StartOutcome> } | null = null;
const KEY_START = "kuber:scored:start";
const KEY_RESULT = "kuber:scored:result";
type StartMarker = { batchName: string; color: string; at: number; requestId?: string };
type StoredResult = { kind: "started"; started: StartedInfo } | { kind: "error"; error: string };
function ssGet<T>(k: string): T | null { try { const r = sessionStorage.getItem(k); return r ? (JSON.parse(r) as T) : null; } catch { return null; } }
function ssSet(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or private mode: the in-memory path still works */ } }
function ssDel(k: string) { try { sessionStorage.removeItem(k); } catch { /* nothing to remove */ } }
/** A marker older than this means the request died with the page; stop waiting for it. */
const START_MAX_AGE_MS = 3 * 60_000;

export function ProspectFinderForm({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useDraft("scored", "step", 0);
  const [keywords, setKeywords] = useDraft<string[]>("scored", "keywords", []);
  const [industryGroups, setIndustryGroups, industryGroupsLoading] = useIndustryKeywordGroups();
  const [countries, setCountries] = useDraft<string[]>("scored", "countries", []);
  const [sizes, setSizes] = useDraft<string[]>("scored", "sizes", []);
  const [lookalikes, setLookalikes] = useDraft<string[]>("scored", "lookalikes", []);
  const [exclude, setExclude] = useDraft<string[]>("scored", "exclude", []);
  const [jobTitles, setJobTitles] = useDraft<string[]>("scored", "jobTitles", []);
  const [advanced, setAdvanced] = useDraft<Record<string, string>>("scored", "advanced", {});
  const [target, setTarget] = useDraft("scored", "target", DEFAULT_TARGET);
  // Follows the lead target until the user types their own limit.
  const [maxCreditsTyped, setMaxCreditsTyped] = useDraft<number | null>("scored", "maxCredits", null);
  const maxCredits = maxCreditsTyped ?? suggestedMaxCredits(target);
  const pages = Math.ceil(target / LEADS_PER_PAGE);
  const needCredits = minCredits(target);
  // An emptied box must block, not keep using the old number.
  const [targetEmpty, setTargetEmpty] = useState(false);
  const [creditsEmpty, setCreditsEmpty] = useState(false);
  // Why a typed number was changed (12.5 → 13, 99999 → the balance): said, never done silently.
  const [targetNote, setTargetNote] = useState<string | null>(null);
  const [creditsNote, setCreditsNote] = useState<string | null>(null);
  const adjustNote = (typed: number, kept: number, overMax: string) =>
    typed === kept ? null : !Number.isInteger(typed) && Math.abs(typed - kept) < 1 ? `Whole numbers only, so ${kept.toLocaleString()} is used.` : typed > kept ? overMax : null;
  const targetMsg = targetEmpty || target < 1 ? "Enter how many leads you want." : null;
  const creditsEmptyMsg = creditsEmpty ? "Enter the most Apollo credits to spend." : null;
  const inputMsg = targetMsg ?? creditsEmptyMsg;
  const pickTarget = (n: number) => { setError(""); setTargetEmpty(false); setTargetNote(null); setTarget(n); };
  const creditsTooLow = !inputMsg && maxCredits < needCredits;
  // undefined = the balances are still loading, null = unknown.
  const [fits, setFits] = useState<Fits | null | undefined>(undefined);
  const [size, setSize] = useState<SizeVerdict>(null);
  const noneLeft = size === "none-left";
  // The credit box cannot go over the Apollo balance when it is known (5,000 otherwise); the field says so.
  const creditCap = fits?.apollo_credits ? Math.min(5000, fits.apollo_credits) : 5000;
  // What stops step 2, each with the lead count that would fit.
  const fitBlock: { msg: string; fix: number } | null =
    targetMsg ? null
    : noneLeft
      ? { msg: "No new leads left for these filters: every page was read in earlier searches. Go back to step 1 and add keywords or countries.", fix: 0 }
    : target > MAX_LEADS_PER_SEARCH
      ? { msg: `One search can give at most ${MAX_LEADS_PER_SEARCH} leads (it checks up to ${(MAX_PAGES_PER_SEARCH * 100).toLocaleString()} companies). Ask for ${MAX_LEADS_PER_SEARCH} or fewer. To get more, run the same search again later: Kuber continues where it stopped.`, fix: MAX_LEADS_PER_SEARCH }
      : fits?.firecrawl_leads != null && target > fits.firecrawl_leads
        ? { msg: `Not enough Firecrawl credits. Kuber reads about 100 company websites (100 Firecrawl credits) for every ${LEADS_PER_PAGE} leads, so ${target} leads need about ${(pages * FIRECRAWL_PER_PAGE).toLocaleString()}. What is left is enough for about ${fits.firecrawl_leads} leads. Ask for fewer leads or top up Firecrawl.`, fix: fits.firecrawl_leads }
        : fits?.apollo_leads != null && target > fits.apollo_leads
          ? { msg: `Not enough Apollo credits. ${target} leads need at least ${needCredits} Apollo credits. What is left is enough for about ${fits.apollo_leads} leads. Ask for fewer leads or top up Apollo.`, fix: fits.apollo_leads }
          : null;
  const creditsMsg = `${target} leads need at least ${needCredits} credits (${target} for the leads + ${pages} for searching). Raise your credits to ${needCredits} or more, or ask for fewer leads.`;
  const [batchName, setBatchName] = useDraft("scored", "batchName", "");
  const [batchColor, setBatchColor] = useDraft("scored", "batchColor", "green");
  const [batchError, setBatchError] = useState(false);
  const [assignMode, setAssignMode] = useDraft<ImportAssignMode>("scored", "assignMode", "pool");
  const [assignTo, setAssignTo] = useDraft("scored", "assignTo", "");
  // One id per wizard session, sent with the search: the server refuses a second search with the
  // same id (a reload mid-request, a second click), so the same search is never paid twice.
  // Cleared with the draft when the search has started, so "Start another search" gets a new one.
  const [requestId, setRequestId] = useDraft("scored", "requestId", "");
  const employees = useAssignableEmployees(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => {
    // Read only. React runs state initialisers twice in development, so deleting here would hand the
    // message to a render that is then thrown away. It is cleared in the mount effect below.
    const r = ssGet<StoredResult>(KEY_RESULT);
    return r?.kind === "error" ? friendlyError(r.error) : "";
  });
  const [started, setStarted] = useState<StartedInfo | null>(() => {
    const r = ssGet<StoredResult>(KEY_RESULT);
    return r?.kind === "started" ? r.started : null;
  });
  /** A search started before this form was (re)opened is still running: its batch name. */
  const [resuming, setResuming] = useState<string | null>(() => {
    if (starting) return starting.batchName;
    const m = ssGet<StartMarker>(KEY_START);
    return m && Date.now() - m.at < START_MAX_AGE_MS ? m.batchName : null;
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    if (ssGet<StoredResult>(KEY_RESULT)?.kind === "error") ssDel(KEY_RESULT); // shown once
    // A started search's draft must never come back as step 4 with "Find N leads" (a second, paid search).
    else if (ssGet<StoredResult>(KEY_RESULT)?.kind === "started") clearDraft("scored");
    const running = starting;
    if (running) {
      void running.promise.then((o) => {
        if (!mountedRef.current) return;
        setResuming(null);
        if (o.ok) setStarted(o.started); else { ssDel(KEY_RESULT); setError(friendlyError(o.error)); }
      });
    } else {
      // The page was reloaded (or hot-reloaded) mid-request: find the search by its batch name.
      const m = ssGet<StartMarker>(KEY_START);
      if (m && Date.now() - m.at < START_MAX_AGE_MS) {
        let alive = true;
        const look = async () => {
          try {
            const d = await api<{ searches: ScoredSearch[] }>("/api/v1/prospects?summary=1");
            // By the request id (the clocks of this computer and the server may differ); old markers by name and time.
            const mine = d.searches.find((x) => (m.requestId ? x.request_id === m.requestId : x.batch_name === m.batchName && new Date(x.created_at).getTime() >= m.at - 5000));
            if (mine && alive) {
              const info = { searchId: mine.id, batchName: m.batchName, color: m.color };
              // The request that would have cleared the draft died with the page: clear it here.
              ssSet(KEY_RESULT, { kind: "started", started: info } satisfies StoredResult); ssDel(KEY_START); clearDraft("scored");
              setResuming(null); setStarted(info); alive = false;
            }
          } catch { /* try again on the next tick */ }
          if (alive && Date.now() - m.at >= START_MAX_AGE_MS) { ssDel(KEY_START); setResuming(null); alive = false; }
        };
        void look();
        const t = setInterval(() => { if (alive) void look(); else clearInterval(t); }, 3000);
        return () => { alive = false; clearInterval(t); mountedRef.current = false; };
      } else if (m) ssDel(KEY_START);
    }
    return () => { mountedRef.current = false; };
  }, []);
  const router = useRouter();
  const pathname = usePathname();

  function next() {
    setError("");
    if (step === 0 && !keywords.length) { setError("Pick at least one industry keyword."); return; }
    if (step === 1 && (inputMsg || creditsTooLow || fitBlock)) return; // the red notes on the page already say why
    if (step === 2 && !batchName.trim()) { setBatchError(true); setError("Give this batch a name so its leads are easy to find later."); return; }
    setStep((s) => s + 1);
  }

  async function startSearch() {
    if (!keywords.length) { setStep(0); setError("Pick at least one industry keyword."); return; }
    if (!batchName.trim()) { setStep(2); setBatchError(true); return; }
    if (inputMsg || creditsTooLow || fitBlock) { setStep(1); setError(inputMsg ?? fitBlock?.msg ?? creditsMsg); return; }
    if (assignMode === "manual" && !assignTo) { setError("Pick the employee who should get these leads."); return; }
    // One search at a time (see `starting`).
    if (starting) { setError("A search is still starting. Wait for it to finish."); return; }
    setError(""); setBusy(true);
    const name = batchName.trim(), color = batchColor;
    const rid = requestId || crypto.randomUUID();
    if (!requestId) setRequestId(rid);
    // Show the progress screen right away. The request can take a long time (several Apollo and
    // database round trips), so the button must not be the only sign anything is happening.
    setResuming(name);
    const payload = {
      keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined,
      lookalike_org_ids: lookalikes.length ? lookalikes : undefined, exclude_websites: exclude.length ? exclude : undefined,
      advanced: buildAdvanced(advanced), target_leads: target, max_credits: maxCredits,
      job_titles: jobTitles.length ? jobTitles : undefined,
      batch_name: name, color, ...buildImportAssignment(assignMode, assignTo), request_id: rid,
    };
    ssDel(KEY_RESULT);
    ssSet(KEY_START, { batchName: name, color, at: Date.now(), requestId: rid } satisfies StartMarker);
    const promise: Promise<StartOutcome> = (async () => {
      try {
        // Already started with this id (e.g. before a reload): show that search, never start another.
        const out = await api<{ search_id: string }>("/api/v1/prospects/search", payload).catch((e: ApiError) => {
          if (e.code === "ALREADY_STARTED" && e.details?.search_id) return { search_id: e.details.search_id };
          throw e;
        });
        clearDraft("scored");
        const started = { searchId: out.search_id, batchName: name, color };
        // Saved here, not by the form, so it is kept even if the form was closed meanwhile.
        ssSet(KEY_RESULT, { kind: "started", started } satisfies StoredResult);
        return { ok: true, started } as StartOutcome;
      } catch (e) {
        ssSet(KEY_RESULT, { kind: "error", error: (e as Error).message } satisfies StoredResult);
        return { ok: false, error: (e as Error).message } as StartOutcome;
      } finally { starting = null; ssDel(KEY_START); }
    })();
    starting = { batchName: name, promise };
    const o = await promise;
    if (!mountedRef.current) return; // closed while it ran: the answer is already in session storage
    setResuming(null);
    if (o.ok) setStarted(o.started); else { ssDel(KEY_RESULT); setError(friendlyError(o.error)); }
    setBusy(false);
  }

  if (resuming && !started) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-[15px] font-semibold">Starting your search</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Looking up companies for &ldquo;{resuming}&rdquo; in Apollo and saving them. This usually takes a few seconds, longer on a slow connection. You can close this window; it keeps going.
        </p>
      </div>
    );
  }

  if (started) {
    return (
      <Started
        searchId={started.searchId}
        batchName={started.batchName}
        batchColor={started.color}
        onOpen={() => {
          // Already on Leads: switch it in place. Elsewhere: open Leads on this batch.
          ssDel(KEY_RESULT);
          if (pathname === "/leads") window.dispatchEvent(new CustomEvent("kuber:open-scored-batch", { detail: { searchId: started.searchId } }));
          else router.push(`/leads?entity=orgs&sbatch=${started.searchId}`);
          onDone?.();
        }}
        onAnother={() => { ssDel(KEY_RESULT); setStarted(null); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Stepper steps={STEPS} current={step} className="pb-4 mb-2 border-b border-border" />

      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Find companies, let the AI read each one&apos;s website or LinkedIn, and reveal <b>one</b> contact only at companies that make plastic products (so they can buy masterbatch). Unclear ones wait for your decision; the rest are hidden.
          </p>
          <IndustryKeywordsDropdown selected={keywords} onChange={setKeywords} groups={industryGroups} onGroupsChange={setIndustryGroups} loading={industryGroupsLoading} />
          <p className="-mt-2 text-xs text-muted-foreground">Pick as many as you like — one search covers all of them and still costs 1 credit per 100 companies.</p>
          <LocationsPicker selected={countries} onChangeSelected={setCountries} />
          <TagInput label="Company size (employees)" pills={sizes} suggestions={SIZE_SUGGESTIONS} onChange={setSizes} allowCustom={false} placeholder="Any size" />
          <JobTitlesPicker
            values={jobTitles}
            onChange={setJobTitles}
            label="Job titles to reveal (optional)"
            placeholder="Any buyer (purchase, owner, plant head, director)"
            tip="At each good-fit company, only a person with one of these titles is revealed (1 credit). If nobody there has one, the company waits in Needs review and nothing is spent. Leave empty to let Kuber pick the best buyer. Titles do not change which companies are found."
          />
          <TagInput label="Lookalike companies (Apollo IDs)" pills={lookalikes} suggestions={[]} onChange={setLookalikes} max={5} placeholder="Optional — up to 5 best customers" tip="Apollo ranks results by similarity to these companies." />
          <TagInput label="Leave out websites" pills={exclude} suggestions={[]} onChange={setExclude} placeholder="Optional — e.g. competitor.com" />
          <CompanyAdvancedSearch value={advanced} onChange={setAdvanced} omit={["employeeRanges", "keywordTags"]} />
        </div>
      )}

      {step === 1 && (
        <div className="@container">
          <div className="space-y-4">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label htmlFor="target-leads">How many leads do you want?</Label>
                  <InfoTip side="right" text="A lead = a plastic maker with a buyer we can email. Kuber checks companies 100 at a time until it has this many leads, your credit limit is reached, or the keywords run out. Searching the same filters again continues where it stopped." />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <NumberInput id="target-leads" min={0} max={100_000} value={targetEmpty ? null : target} aria-invalid={!!(targetMsg || fitBlock)}
                    onAdjust={(t, k) => setTargetNote(adjustNote(t, k, `${k.toLocaleString()} is the most you can type here.`))}
                    onValueChange={(n) => { setError(""); setTargetEmpty(n === null); if (n === null) setTargetNote(null); else setTarget(n); }} className="w-28" />
                  {TARGET_CHIPS.map((n) => (
                    <Button key={n} type="button" variant="outline" className={cn("tabular-nums", target === n && "border-primary/50 bg-primary/5 hover:bg-primary/5")} onClick={() => pickTarget(n)}>{n}</Button>
                  ))}
                </div>
                {targetMsg && <p className="flex items-start gap-1.5 text-sm font-medium text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{targetMsg}</p>}
                {!targetMsg && targetNote && <p className="text-xs text-amber-700 dark:text-amber-300">{targetNote}</p>}
              </div>
              {fitBlock && (
                <div className="flex items-start gap-1.5 text-sm font-medium text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1.5">
                    <p>{fitBlock.msg}</p>
                    {fitBlock.fix > 0 && <Button type="button" size="sm" variant="outline" onClick={() => pickTarget(fitBlock.fix)}>Ask for {fitBlock.fix} leads instead</Button>}
                  </div>
                </div>
              )}
              <MarketSize target={targetMsg ? 0 : target} onPick={pickTarget} onFits={setFits} onSize={setSize} filters={{
                keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined,
                lookalike_org_ids: lookalikes.length ? lookalikes : undefined, exclude_websites: exclude.length ? exclude : undefined,
                advanced: buildAdvanced(advanced),
              }} />
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label htmlFor="max-credits">Most Apollo credits to spend</Label>
                  <InfoTip side="right" text={`1 credit per search of 100 companies, then 1 per lead. Kuber never goes over this number; it stops and tells you how many leads it found. Each approval in review is 1 more credit. Suggested for ${target} lead${target === 1 ? "" : "s"}: at least ${needCredits}, plus 10% extra in case some companies have nobody to email.`} />
                </div>
                <div className="flex items-center gap-2">
                  <NumberInput id="max-credits" min={0} max={creditCap} value={creditsEmpty ? null : maxCredits} aria-invalid={creditsTooLow || creditsEmpty}
                    onAdjust={(t, k) => setCreditsNote(adjustNote(t, k, creditCap === fits?.apollo_credits
                      ? `Your Apollo balance is ${creditCap.toLocaleString()} credits, so ${creditCap.toLocaleString()} is the most you can set.`
                      : `${creditCap.toLocaleString()} is the most one search can use.`))}
                    onValueChange={(n) => { setError(""); setCreditsEmpty(n === null); if (n === null) setCreditsNote(null); else setMaxCreditsTyped(n); }} className="w-28" />
                  {(maxCreditsTyped !== null || creditsEmpty) && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setCreditsEmpty(false); setCreditsNote(null); setMaxCreditsTyped(null); }}>Use suggested ({suggestedMaxCredits(target)})</Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{fits === undefined ? "Checking your Apollo balance…" : creditCap === fits?.apollo_credits ? `Most you can set: ${creditCap.toLocaleString()}, your Apollo balance.` : `Most you can set: ${creditCap.toLocaleString()}.`}</p>
                {!creditsEmpty && creditsNote && <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{creditsNote}</p>}
                {creditsEmptyMsg && <p className="flex items-start gap-1.5 text-sm font-medium text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{creditsEmptyMsg}</p>}
                {creditsTooLow && <p className="flex items-start gap-1.5 text-sm font-medium text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />Not enough credits. {creditsMsg}</p>}
              </div>
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium text-foreground">What happens to each company</p>
                <div className="flex flex-nowrap items-center gap-2">
                  {[
                    { label: "Good fit", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300", tip: "Makes plastic products: one buyer is revealed automatically (1 credit)." },
                    { label: "Needs review", tone: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300", tip: "The AI can't tell, no website, unclear LinkedIn, or website down. Waits for you; no cost until you approve." },
                    { label: "Hidden", tone: "bg-secondary text-muted-foreground", tip: "Not a plastic maker (traders, distributors, machine makers, brands that only use packaging). Nothing spent." },
                  ].map((g) => (
                    <span key={g.label} className={cn("inline-flex items-center gap-1 rounded-[5px] px-1.5 py-[3px] text-xs font-medium", g.tone)}>
                      {g.label}<InfoTip side="top" text={g.tip} />
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {/* Over the 20-page cap the bill would promise pages a search never reads; the block message explains instead. */}
            {!inputMsg && target <= MAX_LEADS_PER_SEARCH && <Bill target={target} maxCredits={maxCredits} firecrawlShort={fits?.firecrawl_leads != null && target > fits.firecrawl_leads} size={size} jobTitles={jobTitles.length} />}
            {fits && (fits.apollo_leads != null || fits.firecrawl_leads != null) && (
              <div className="space-y-1 text-[13px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
                {fits.apollo_leads != null && <p>Apollo credits left: {fits.apollo_credits != null ? `${fits.apollo_credits.toLocaleString()} → ` : ""}enough for about {fits.apollo_leads.toLocaleString()} leads</p>}
                {fits.firecrawl_leads != null && <p>Firecrawl credits left: {fits.firecrawl_credits != null ? `${fits.firecrawl_credits.toLocaleString()} → ` : ""}enough for about {fits.firecrawl_leads.toLocaleString()} leads</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <BatchNameField value={batchName} onChange={(v) => { setBatchName(v); setBatchError(false); }} color={batchColor} onColorChange={setBatchColor} error={batchError} />
      )}

      {step === 3 && (
        <div className="space-y-4">
          <AssignStrategyPicker employees={employees} mode={assignMode} onModeChange={setAssignMode} assignTo={assignTo} onAssignToChange={setAssignTo} />
          <ApolloCostNote
            credits={maxCredits}
            spendingOn={`at most (about ${needCredits} expected) for ${target} leads: ~${pages} search${pages === 1 ? "" : "es"} of 100 companies + 1 credit per lead${jobTitles.length ? `. Only people with these job titles are revealed: ${jobTitles.join(", ")}` : ""}`}
            rate={`At most this many Apollo credits: 1 per search of 100 companies, then 1 per lead. Companies that aren't plastic makers, or have nobody with an email, cost nothing.${jobTitles.length ? " Companies with nobody of your job titles wait in Needs review for free, so you may get fewer automatic leads." : ""} Reading websites uses about 1 Firecrawl credit per company.`}
          />
        </div>
      )}

      {error && <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}

      <div className="flex justify-between">
        <div className="flex items-center gap-1">
          {step > 0 && <Button type="button" variant="outline" onClick={() => { setError(""); setStep((s) => s - 1); }}>Back</Button>}
        </div>
        {step < STEPS.length - 1 ? (
          <Button type="button" onClick={next} disabled={step === 1 && (!!inputMsg || creditsTooLow || !!fitBlock)}>Next</Button>
        ) : (
          <Button type="button" onClick={startSearch} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Find {target} leads
          </Button>
        )}
      </div>
    </div>
  );
}
