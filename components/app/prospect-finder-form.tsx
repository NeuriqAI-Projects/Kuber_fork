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
import {
  AssignStrategyPicker, BatchNameField, buildImportAssignment, getToken, IndustryKeywordsDropdown,
  useAssignableEmployees, useIndustryKeywordGroups, type ImportAssignMode,
} from "@/components/app/lead-forms";
import type { ScoredSearch } from "@/components/app/scored-orgs";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { Stepper } from "@/components/ui/stepper";
import { getBatchColor } from "@/lib/constants";
import { cn } from "@/lib/utils";

const STEPS = ["Criteria", "Settings", "Batch", "Assign"];
const SIZE_SUGGESTIONS = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,10000"];
/** Default Apollo limit for one batch: 1 search + up to 39 contacts. One batch of
 *  100 companies gave about 33 leads in the 17 Oct 2026 live tests. */
const DEFAULT_MAX_CREDITS = 40;
/** Measured live on 17 Oct 2026 with only the every-minute background job. */
const COMPANIES_PER_MINUTE = 20;

interface MarketEstimate { companies: { low: number; mid: number; high: number }; leads: { low: number; high: number } }

/** Expected Apollo use for one batch, from the 17 Oct 2026 live tests: about
 *  25–40 leads per 100 companies with good keywords (1 credit each), plus 1 for
 *  the search, and never more than the limit. */
function ExpectedUse({ maxCredits }: { maxCredits: number }) {
  const contacts = Math.max(0, maxCredits - 1);
  const low = 1 + Math.min(contacts, 25), high = 1 + Math.min(contacts, 40);
  return (
    <div className="space-y-1 rounded-lg border border-border px-3 py-2.5 text-sm">
      <p><b>Expected use: about {low === high ? low : `${low}–${high}`} credits</b> · never more than {maxCredits}.</p>
      <p className="text-xs text-muted-foreground">
        1 credit for the search (up to 100 companies) + 1 per lead. One batch usually gives about 25–40 leads with good keywords.
        {contacts < 40 && ` With this limit you get at most ${contacts} lead${contacts === 1 ? "" : "s"}; extra good companies wait for your review (1 credit each if you approve).`}
        {" "}Companies that aren&apos;t plastic makers, or have nobody with an email, cost nothing.
      </p>
    </div>
  );
}

/** Free size check (Apollo People Search, 0 credits) shown under the filters. */
function MarketSize({ keywords, countries, sizes }: { keywords: string[]; countries: string[]; sizes: string[] }) {
  const [est, setEst] = useState<MarketEstimate | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const key = JSON.stringify([keywords, countries, sizes]);
  useEffect(() => {
    if (!keywords.length) { setEst(null); setState("idle"); return; }
    let alive = true;
    setState("loading");
    const t = setTimeout(() => {
      api<MarketEstimate>("/api/v1/prospects/estimate", { keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined })
        .then((e) => { if (alive) { setEst(e); setState("idle"); } })
        .catch(() => { if (alive) setState("error"); });
    }, 600);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!keywords.length) return null;
  const n = (x: number) => x.toLocaleString();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-sm">
      {state === "loading" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        {state === "error" && <p className="text-muted-foreground">Couldn&apos;t check the size right now. You can still search.</p>}
        {state !== "error" && !est && <p className="text-muted-foreground">Checking how many companies match…</p>}
        {state !== "error" && est && (
          est.companies.mid === 0
            ? <p className="font-medium text-amber-600 dark:text-amber-400">Apollo has almost no companies for these keywords. Try a different keyword.</p>
            : <p>
                <b>About {n(est.companies.mid)} companies</b> match ({n(est.companies.low)}–{n(est.companies.high)}) · <b>about {n(est.leads.low)}–{n(est.leads.high)} leads</b> possible in total.
              </p>
        )}
        <p className="flex items-center gap-1 text-xs text-muted-foreground">Free check, no credits used. One batch reads up to 100 of these.
          <InfoTip side="right" text="Estimated from Apollo's free People Search. It is a range: the exact number of companies is only known after the paid search. About 1 in 3 companies becomes a lead (makes plastic and has a person with an email)." />
        </p>
      </div>
    </div>
  );
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json?.data as T;
}

/** "Search started": live numbers for the search just launched, and where to go next. */
function Started({ searchId, batchName, batchColor, onOpen, onAnother }: {
  searchId: string; batchName: string; batchColor: string; onOpen: () => void; onAnother: () => void;
}) {
  const [s, setS] = useState<ScoredSearch | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const kicking = useRef(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const d = await api<{ searches: ScoredSearch[] }>("/api/v1/prospects?summary=1");
        const mine = d.searches.find((x) => x.id === searchId) ?? null;
        if (!alive) return;
        setS(mine); setNetError(null);
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
  const checked = s?.stages.scored ?? 0;
  const left = Math.max(0, total - checked);
  const done = !!s && s.in_progress === 0;
  const tile = "flex flex-col gap-1 rounded-xl border border-border bg-field p-4 dark:bg-card";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 py-2">
      <div className="flex items-center gap-4 rounded-2xl border border-border bg-field p-5 dark:bg-card">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          {done ? <Check className="size-7" /> : <Loader2 className="size-7 animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xl font-bold">{done ? "All companies checked" : "Search started"}</p>
          <p className="text-sm text-muted-foreground">
            {done ? "Good fits are getting their contact; the rest wait in Organizations." : "Kuber is checking every company in the background. You can close this window — nothing stops."}
          </p>
        </div>
        <span className={cn("inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs font-semibold", getBatchColor(batchColor).pill)}>{batchName}</span>
      </div>

      {netError && <p className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400"><CircleAlert className="size-4" />Can&apos;t reach the server right now ({netError}). The search keeps running; these numbers update when the connection is back.</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Companies found</span>
          <span className="text-3xl font-bold tabular-nums">{s?.returned ?? "…"}</span>
          <span className="text-xs text-muted-foreground">{s ? `${s.total} new to you` : " "}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Checked so far</span>
          <span className="text-3xl font-bold tabular-nums text-primary">{checked}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-all duration-500" style={{ width: `${total ? (checked / total) * 100 : 0}%` }} /></div>
        </div>
        <div className={tile}>
          <span className="text-xs text-muted-foreground">Time left</span>
          <span className="text-3xl font-bold tabular-nums">{done ? "Done" : `~${Math.max(1, Math.ceil(left / COMPANIES_PER_MINUTE))} min`}</span>
          <span className="text-xs text-muted-foreground">about {COMPANIES_PER_MINUTE} companies a minute</span>
        </div>
      </div>

      <div className="divide-y divide-border rounded-xl border border-border bg-field px-4 dark:bg-card">
        {[
          { icon: <Check className="size-4" />, tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", title: "Good fits", text: "One contact revealed automatically, then it appears in Leads", side: s ? `${s.groups.good} so far` : "" },
          { icon: <CircleAlert className="size-4" />, tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400", title: "Need your review", text: "Approve or decline them in Organizations", side: s ? `${s.groups.review} so far · no cost until approved` : "" },
          { icon: <X className="size-4" />, tone: "bg-secondary text-muted-foreground", title: "Not a fit", text: "Traders, distributors, machine makers — hidden", side: s ? `${s.groups.hidden} · nothing spent` : "" },
        ].map((r) => (
          <div key={r.title} className="flex items-center gap-3 py-3">
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", r.tone)}>{r.icon}</span>
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{r.title}</p><p className="text-xs text-muted-foreground">{r.text}</p></div>
            <span className="shrink-0 text-xs text-muted-foreground">{r.side}</span>
          </div>
        ))}
      </div>

      {s && (
        <p className="rounded-lg border border-border px-3 py-2 text-sm">
          <b>Apollo credits used so far: {s.credits_used}</b>{s.max_credits != null ? ` of your limit of ${s.max_credits}` : ""} ({s.credits_spent} for the search + {s.credits_used - s.credits_spent} contact{s.credits_used - s.credits_spent === 1 ? "" : "s"}){s.mock ? " · test batch, nothing is charged" : ""}.
          <span className="text-muted-foreground"> Website reading: about {s.stages.read} Firecrawl credits.</span>
        </p>
      )}

      {s && s.stages.waiting_credits > 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          Apollo ran out of credits: {s.stages.waiting_credits} good compan{s.stages.waiting_credits === 1 ? "y is" : "ies are"} waiting. They continue on their own after a top-up — nothing is lost.
        </p>
      )}

      <div className="flex justify-center gap-2">
        <Button type="button" onClick={onOpen}>Open in Organizations →</Button>
        <Button type="button" variant="outline" onClick={onAnother}>Start another search</Button>
      </div>
    </div>
  );
}

export function ProspectFinderForm({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useState(0);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [industryGroups, setIndustryGroups] = useIndustryKeywordGroups();
  const [countries, setCountries] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [lookalikes, setLookalikes] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [maxCredits, setMaxCredits] = useState(DEFAULT_MAX_CREDITS);
  const [batchName, setBatchName] = useState("");
  const [batchColor, setBatchColor] = useState("green");
  const [batchError, setBatchError] = useState(false);
  const [assignMode, setAssignMode] = useState<ImportAssignMode>("pool");
  const [assignTo, setAssignTo] = useState("");
  const employees = useAssignableEmployees(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState<{ searchId: string; batchName: string; color: string } | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  function next() {
    setError("");
    if (step === 0 && !keywords.length) { setError("Pick at least one industry keyword."); return; }
    if (step === 2 && !batchName.trim()) { setBatchError(true); setError("Give this batch a name so its leads are easy to find later."); return; }
    setStep((s) => s + 1);
  }

  async function startSearch() {
    if (!keywords.length) { setStep(0); setError("Pick at least one industry keyword."); return; }
    if (!batchName.trim()) { setStep(2); setBatchError(true); return; }
    if (assignMode === "manual" && !assignTo) { setError("Pick the employee who should get these leads."); return; }
    setError(""); setBusy(true);
    try {
      const out = await api<{ search_id: string }>("/api/v1/prospects/search", {
        keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined,
        lookalike_org_ids: lookalikes.length ? lookalikes : undefined, exclude_websites: exclude.length ? exclude : undefined,
        advanced: buildAdvanced(advanced), max_auto_reveals: Math.max(0, maxCredits - 1), page: 1,
        batch_name: batchName.trim(), color: batchColor, ...buildImportAssignment(assignMode, assignTo),
      });
      setStarted({ searchId: out.search_id, batchName: batchName.trim(), color: batchColor });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (started) {
    return (
      <Started
        searchId={started.searchId}
        batchName={started.batchName}
        batchColor={started.color}
        onOpen={() => {
          // Already on Leads: switch it in place. Elsewhere: open Leads on this batch.
          if (pathname === "/leads") window.dispatchEvent(new CustomEvent("kuber:open-scored-batch", { detail: { searchId: started.searchId } }));
          else router.push(`/leads?entity=orgs&sbatch=${started.searchId}`);
          onDone?.();
        }}
        onAnother={() => { setStarted(null); setStep(0); setBatchName(""); }}
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
          <IndustryKeywordsDropdown selected={keywords} onChange={setKeywords} groups={industryGroups} onGroupsChange={setIndustryGroups} />
          <p className="-mt-2 text-xs text-muted-foreground">Pick as many as you like — one search covers all of them and still costs 1 credit per 100 companies.</p>
          <LocationsPicker selected={countries} onChangeSelected={setCountries} />
          <TagInput label="Company size (employees)" pills={sizes} suggestions={SIZE_SUGGESTIONS} onChange={setSizes} allowCustom={false} placeholder="Any size" />
          <TagInput label="Lookalike companies (Apollo IDs)" pills={lookalikes} suggestions={[]} onChange={setLookalikes} max={5} placeholder="Optional — up to 5 best customers" tip="Apollo ranks results by similarity to these companies." />
          <TagInput label="Leave out websites" pills={exclude} suggestions={[]} onChange={setExclude} placeholder="Optional — e.g. competitor.com" />
          <CompanyAdvancedSearch value={advanced} onChange={setAdvanced} omit={["employeeRanges", "keywordTags"]} />
          <MarketSize keywords={keywords} countries={countries} sizes={sizes} />
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="max-credits">Most Apollo credits to spend on this batch</Label>
              <InfoTip side="right" text="1 credit for the search (up to 100 companies), then 1 credit per contact revealed at a good-fit company. The batch never goes over this number; extra good fits wait for your review, where each approval is 1 more credit." />
            </div>
            <Input id="max-credits" type="number" min={1} max={101} value={maxCredits}
              onChange={(e) => setMaxCredits(Math.max(1, Math.min(101, Number(e.target.value) || 1)))} className="w-32" />
            <ExpectedUse maxCredits={maxCredits} />
          </div>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p><b className="text-foreground">Good fit</b> — makes plastic products: one contact is revealed automatically. Score 9 if it makes the products you searched for, 7 if other plastic products.</p>
            <p><b className="text-foreground">Needs review</b> — the AI can&apos;t tell, no website, unclear LinkedIn, or website down. You decide in Organizations.</p>
            <p><b className="text-foreground">Hidden</b> — not a plastic maker (traders, distributors, machine makers, brands that only use packaging). Still saved.</p>
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
            spendingOn={`1 company search (up to 100 companies) + up to ${Math.max(0, maxCredits - 1)} contacts revealed`}
            rate="At most this many Apollo credits: 1 for the search, then 1 per contact revealed. Companies that aren't plastic makers, or have nobody with an email, cost nothing. Reading websites uses about 1 Firecrawl credit per company (up to 100)."
          />
        </div>
      )}

      {error && <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}

      <div className="flex justify-between">
        {step > 0 ? <Button type="button" variant="outline" onClick={() => { setError(""); setStep((s) => s - 1); }}>Back</Button> : <span />}
        {step < STEPS.length - 1 ? (
          <Button type="button" onClick={next}>Next</Button>
        ) : (
          <Button type="button" onClick={startSearch} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Search &amp; score companies
          </Button>
        )}
      </div>
    </div>
  );
}
