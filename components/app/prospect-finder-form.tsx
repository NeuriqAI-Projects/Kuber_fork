"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Brain, Building2, Check, CheckCircle2, ExternalLink, EyeOff, Globe, Loader2, Search, Sparkles, UserCheck, XCircle } from "lucide-react";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { TagInput } from "@/components/app/tag-input";
import { buildAdvanced, CompanyAdvancedSearch } from "@/components/app/company-lookup-form";
import {
  AssignStrategyPicker, BatchNameField, buildImportAssignment, getToken, IndustryKeywordsDropdown,
  useAssignableEmployees, useIndustryKeywordGroups, type ImportAssignMode,
} from "@/components/app/lead-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";

type View = "good" | "review" | "hidden" | "working";

interface Prospect {
  id: string; name: string; domain: string | null; website_url: string | null; linkedin_url: string | null;
  status: string; score: number | null; reason: string | null; text_source: string | null;
  extra_sources: string[]; last_error: string | null; attempts: number;
}
interface SearchFilters {
  batch_name?: string;
  keywords?: string[]; keyword_labels?: string[]; locations?: string[]; employee_ranges?: string[];
  lookalike_org_ids?: string[]; exclude_websites?: string[]; advanced?: Record<string, unknown>; max_auto_reveals?: number;
}
interface SearchRow {
  id: string; filters: SearchFilters; status: string; credits_spent: number; returned: number | null; new_companies: number | null;
  error: string | null; mock: boolean; created_at: string; total: number; in_progress: number;
}
interface Stages { found: number; read: number; scored: number; to_reveal: number; revealed: number; waiting_credits: number }
interface ListData { searches: SearchRow[]; search_id: string | null; counts: Record<View, number>; stages?: Stages; companies: Prospect[] }

const STEPS = ["Criteria", "Settings", "Batch", "Assign"];
const SIZE_SUGGESTIONS = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,10000"];
const DEFAULT_MAX_REVEALS = 20;

/** Plain-words label for every pipeline status. */
const STATUS: Record<string, string> = {
  queued: "Waiting to read", read_social: "Website down — reading LinkedIn", read: "Scoring",
  good: "Good fit — finding contact", approved: "Approved — finding contact", waiting_credits: "Waiting for Apollo credits",
  promoted: "Contact added — email being revealed", no_contact: "No one with an email at this company",
  review: "Needs your decision", flagged: "Can't score — needs your decision", site_down: "Website down",
  hidden: "Poor fit", rejected: "Rejected",
};

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed: ${res.status}`);
  return json?.data as T;
}

/** A stored advanced filter (lists, numbers) back into the panel's raw text fields. */
function toRaw(adv: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(adv ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
}

function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">–</span>;
  const tone = score >= 7 ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-500" : score >= 4 ? "border-amber-500/30 bg-amber-500/15 text-amber-500" : "border-red-500/30 bg-red-500/15 text-red-500";
  return <Badge variant="outline" className={cn("tabular-nums", tone)}>{score}</Badge>;
}

type StageState = "done" | "active" | "waiting";

function StageCard({ index, icon: Icon, title, state, done, total, detail }: {
  index: number; icon: typeof Search; title: string; state: StageState; done: number; total: number; detail: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : state === "done" ? 100 : 0;
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-4", state === "active" ? "border-primary/40 bg-primary/5" : "border-border bg-field dark:bg-card")}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          state === "done" ? "bg-primary text-primary-foreground" : state === "active" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
          {state === "done" ? <Check className="size-3.5" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : index}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><Icon className="size-3.5 shrink-0 text-muted-foreground" />{title}</span>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg font-semibold tabular-nums">{done}<span className="text-sm font-normal text-muted-foreground"> / {total}</span></span>
          <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

/** Shown while a search is being worked on: where every company is, stage by stage. */
function SearchProgress({ search, stages, counts }: { search: SearchRow; stages: Stages; counts: Record<View, number> }) {
  const { found, read, scored, to_reveal, revealed, waiting_credits } = stages;
  const stageState = (done: number, total: number, started: boolean): StageState =>
    total > 0 && done >= total ? "done" : started ? "active" : "waiting";
  const readState = stageState(read, found, true);
  const scoreState = stageState(scored, found, read > 0);
  const revealState: StageState = scoreState === "done" && revealed >= to_reveal ? "done" : to_reveal > 0 ? "active" : "waiting";
  // Reading + scoring are 90% of the work; reveals the last 10%.
  const overall = found
    ? Math.round(((read + scored) / (2 * found)) * 90 + (to_reveal ? (revealed / to_reveal) * 10 : scoreState === "done" ? 10 : 0))
    : 0;
  const alreadyYours = (search.returned ?? 0) - found;
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">{search.filters.batch_name ?? "Scored search"}</p>
          <p className="text-xs text-muted-foreground">
            Started {new Date(search.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · runs in the background — you can close this window
          </p>
        </div>
        <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold tabular-nums text-primary">{overall}% done</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StageCard index={1} icon={Building2} title="Find companies" state="done" done={found} total={found}
          detail={`${search.returned ?? found} found in Apollo · ${search.credits_spent} credit${search.credits_spent === 1 ? "" : "s"}${alreadyYours > 0 ? ` · ${alreadyYours} already yours` : ""}`} />
        <StageCard index={2} icon={Globe} title="Read websites" state={readState} done={read} total={found}
          detail="Home page, or LinkedIn when there's no website" />
        <StageCard index={3} icon={Brain} title="AI scoring" state={scoreState} done={scored} total={found}
          detail={`${counts.good} good · ${counts.review} for you · ${counts.hidden} hidden`} />
        <StageCard index={4} icon={UserCheck} title="Reveal contacts" state={revealState} done={revealed} total={to_reveal}
          detail={waiting_credits ? `${waiting_credits} waiting for Apollo credits` : "One contact per good-fit company"} />
      </div>
    </div>
  );
}

export function ProspectFinderForm() {
  // ── wizard ──
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

  // ── results ──
  const [view, setView] = useState<View>("good");
  const [searchId, setSearchId] = useState<string | null>(null);
  const [data, setData] = useState<ListData | null>(null);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [peek, setPeek] = useState(false);
  const running = useRef(false);
  const prefilled = useRef(false);

  const load = useCallback(async (sid = searchId, v = view) => {
    const q = new URLSearchParams({ view: v, ...(sid ? { search_id: sid } : {}) });
    const d = await api<ListData>(`/api/v1/prospects?${q}`);
    setData(d);
    if (!sid && d.search_id) setSearchId(d.search_id);
    // Coming back to the page: the last search's filters are filled in again
    // and a running search shows its progress. Everything lives server-side,
    // so nothing restarts and nothing is lost by leaving.
    if (!prefilled.current && d.searches[0]) {
      prefilled.current = true;
      const f = d.searches[0].filters;
      setKeywords(f.keyword_labels ?? f.keywords ?? []); setCountries(f.locations ?? []); setSizes(f.employee_ranges ?? []);
      setLookalikes(f.lookalike_org_ids ?? []); setExclude(f.exclude_websites ?? []); setAdvanced(toRaw(f.advanced));
      if (typeof f.max_auto_reveals === "number") setMaxReveals(f.max_auto_reveals);
      if (!sid && d.counts.working > 0 && v === "good") setView("working");
    }
    return d;
  }, [searchId, view]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // While ANY search still has work, advance it and refresh. In production the
  // minute pump does the same with the page closed; running both is safe (row locks).
  const pending = (data?.searches ?? []).some((s) => s.in_progress > 0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      if (running.current) return;
      running.current = true;
      try { await api("/api/v1/prospects/run", { method: "POST" }); await load(); } catch { /* next tick */ } finally { running.current = false; }
    }, 4000);
    return () => clearInterval(t);
  }, [pending, load]);

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
        method: "POST",
        body: {
          keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined,
          lookalike_org_ids: lookalikes.length ? lookalikes : undefined, exclude_websites: exclude.length ? exclude : undefined,
          advanced: buildAdvanced(advanced), max_auto_reveals: maxReveals, page: 1,
          batch_name: batchName.trim(), color: batchColor, ...buildImportAssignment(assignMode, assignTo),
        },
      });
      setSearchId(out.search_id); setView("working"); setBatchName(""); setStep(0);
      await load(out.search_id, "working");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function decide(id: string, action: "approve" | "reject" | "retry") {
    setActing(id);
    try { await api(`/api/v1/prospects/${id}`, { method: "POST", body: { action } }); await load(); }
    catch (e) { setError((e as Error).message); } finally { setActing(null); }
  }

  const current = data?.searches.find((s) => s.id === searchId);
  const counts = data?.counts ?? { good: 0, review: 0, hidden: 0, working: 0 };
  const runningCount = (data?.searches ?? []).reduce((n, s) => n + s.in_progress, 0);
  const currentRunning = !!current && current.in_progress > 0;
  const batchLabel = (s: SearchRow) => s.filters.batch_name ?? (s.filters.keyword_labels ?? s.filters.keywords ?? []).join(", ");

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <Stepper steps={STEPS} current={step} className="pb-4 mb-2 border-b border-border" />

        {step === 0 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Find companies, let the AI score each one 1–10 from its website or LinkedIn, and reveal <b>one</b> contact only at good fits (7+). Scores 4–6 wait for your decision; 1–3 are hidden.
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
                <InfoTip side="right" text="Good fits (7+) are revealed automatically, one contact per company, up to this number. Extra good fits wait in “Your decision”. Each reveal is 1 Apollo credit." />
              </div>
              <Input id="max-reveals" type="number" min={0} max={100} value={maxReveals}
                onChange={(e) => setMaxReveals(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-32" />
            </div>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p><b className="text-foreground">7–10</b> — good fit: one contact is revealed automatically.</p>
              <p><b className="text-foreground">4–6</b>, no website, unclear LinkedIn or website down — waits for your decision.</p>
              <p><b className="text-foreground">1–3</b> — poor fit: hidden (still saved).</p>
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
              mock={current?.mock}
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

      {data && data.searches.length > 0 && (
        <div className="space-y-3 border-t border-border pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={searchId ?? undefined} onValueChange={(v) => { setSearchId(v); setPeek(false); }}>
              <SelectTrigger className="h-9 w-[28rem] max-w-full"><SelectValue placeholder="Pick a search" /></SelectTrigger>
              <SelectContent>
                {data.searches.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {batchLabel(s)}
                    <span className="text-muted-foreground">
                      {" · "}{new Date(s.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
                      {s.in_progress > 0 ? ` · running, ${s.total - s.in_progress}/${s.total}` : ` · ${s.total} companies`}
                      {s.mock ? " · test" : ""}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {current && (
              <span className="text-xs text-muted-foreground">
                {current.status === "paying" ? "Charge unknown — Apollo didn't answer. " : ""}
                {current.status === "failed" ? `Search failed: ${current.error ?? ""}` : `${current.returned ?? 0} found · ${current.new_companies ?? 0} new · ${current.credits_spent} Apollo credit${current.credits_spent === 1 ? "" : "s"}`}
              </span>
            )}
          </div>

          {pending && !currentRunning && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              <span>Another search is still working on {runningCount} compan{runningCount === 1 ? "y" : "ies"} in the background. Pick it above to watch it.</span>
            </div>
          )}

          {currentRunning && current && data.stages && (
            <>
              <SearchProgress search={current} stages={data.stages} counts={counts} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setPeek((p) => !p)}>
                {peek ? "Hide results so far" : "Show results so far"}
              </Button>
            </>
          )}

          {(!currentRunning || peek) && (<>
          <SegmentedTabs<View>
            value={view}
            onValueChange={setView}
            options={[
              { value: "good", label: "Good fit", icon: CheckCircle2, count: counts.good },
              { value: "review", label: "Your decision", icon: Sparkles, count: counts.review },
              { value: "hidden", label: "Hidden", icon: EyeOff, count: counts.hidden },
              { value: "working", label: "In progress", icon: Loader2, count: counts.working },
            ]}
          />

          {view === "review" && counts.review > 0 && (
            <ApolloCostNote credits={1} spendingOn="each company you approve (one contact's email)" rate="1 credit per contact revealed. Retrying a website that was down uses 1 Firecrawl credit, not Apollo." mock={current?.mock} />
          )}

          {data.companies.length === 0 ? (
            <EmptyState message={view === "working" ? "Nothing in progress." : "No companies here yet."} />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border bg-field dark:bg-card">
              {data.companies.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <ScorePill score={c.score} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    {/* Links so the client can check the company themselves before deciding. */}
                    <div className="flex flex-wrap gap-3 text-xs">
                      {(c.website_url || c.domain) && (
                        <a href={c.website_url ?? `https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          <ExternalLink className="size-3" />{c.domain ?? "Website"}
                        </a>
                      )}
                      {c.linkedin_url && (
                        <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          <ExternalLink className="size-3" />LinkedIn
                        </a>
                      )}
                      {!c.website_url && !c.domain && !c.linkedin_url && <span className="text-muted-foreground">No website or LinkedIn</span>}
                    </div>
                    {c.reason && <p className="truncate text-xs text-muted-foreground">{c.reason}{c.text_source && c.text_source !== "website" ? ` · from ${c.text_source}` : ""}{c.extra_sources?.length ? ` · +${c.extra_sources.length} extra source${c.extra_sources.length > 1 ? "s" : ""}` : ""}</p>}
                    <p className="text-xs text-muted-foreground">{STATUS[c.status] ?? c.status}{c.last_error ? ` — ${c.last_error}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {["review", "flagged", "hidden"].includes(c.status) && (
                      <Button size="sm" variant="outline" disabled={acting === c.id} onClick={() => decide(c.id, "approve")}><CheckCircle2 className="size-3.5" />Approve</Button>
                    )}
                    {c.status === "site_down" && (
                      <Button size="sm" variant="outline" disabled={acting === c.id} onClick={() => decide(c.id, "retry")}>Retry (1 Firecrawl credit)</Button>
                    )}
                    {["review", "flagged", "site_down"].includes(c.status) && (
                      <Button size="sm" variant="ghost" disabled={acting === c.id} onClick={() => decide(c.id, "reject")}><XCircle className="size-3.5" />Reject</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          </>)}
        </div>
      )}
    </div>
  );
}
