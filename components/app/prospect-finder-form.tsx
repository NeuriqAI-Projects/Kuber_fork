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
const DEFAULT_MAX_REVEALS = 20;
/** Measured on 200 real companies, 9 Oct 2026. */
const COMPANIES_PER_MINUTE = 55;

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
          <span className="text-xs text-muted-foreground">{s ? `${s.total} new · ${s.credits_spent} Apollo credit${s.credits_spent === 1 ? "" : "s"}${s.mock ? " (test)" : ""}` : " "}</span>
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
  const [maxReveals, setMaxReveals] = useState(DEFAULT_MAX_REVEALS);
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
        advanced: buildAdvanced(advanced), max_auto_reveals: maxReveals, page: 1,
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
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="max-reveals">Most contacts to reveal automatically</Label>
              <InfoTip side="right" text="Good fits are revealed automatically, one contact per company, up to this number. Extra good fits wait for your review. Each reveal is 1 Apollo credit." />
            </div>
            <Input id="max-reveals" type="number" min={0} max={100} value={maxReveals}
              onChange={(e) => setMaxReveals(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-32" />
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
            credits={1 + maxReveals}
            spendingOn={`1 company search (up to 100 companies) + up to ${maxReveals} automatic reveals`}
            rate="1 credit per page of up to 100 companies, then 1 credit per contact revealed (one per good-fit company). Reading and scoring don't use Apollo credits."
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
