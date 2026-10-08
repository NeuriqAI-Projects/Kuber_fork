"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, EyeOff, Loader2, Search, Sparkles, XCircle } from "lucide-react";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { TagInput } from "@/components/app/tag-input";
import { BatchNameField, getToken } from "@/components/app/lead-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type View = "good" | "review" | "hidden" | "working";

interface Prospect {
  id: string; name: string; domain: string | null; website_url: string | null; linkedin_url: string | null;
  status: string; score: number | null; reason: string | null; text_source: string | null;
  extra_sources: string[]; last_error: string | null; attempts: number;
}
interface SearchRow { id: string; filters: { keywords?: string[]; locations?: string[]; employee_ranges?: string[]; lookalike_org_ids?: string[]; exclude_websites?: string[] }; status: string; credits_spent: number; returned: number | null; new_companies: number | null; error: string | null; mock: boolean; created_at: string }
interface ListData { searches: SearchRow[]; search_id: string | null; counts: Record<View, number>; companies: Prospect[] }

const KEYWORD_SUGGESTIONS = ["blown film", "plastic film", "flexible packaging", "injection molding", "blow molding", "extrusion", "thermoforming", "plastic packaging", "plastic pipes", "pet preform", "plastic bags", "rotomoulding", "compounding"];
const SIZE_SUGGESTIONS = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,10000"];

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

function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">–</span>;
  const tone = score >= 7 ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-500" : score >= 4 ? "border-amber-500/30 bg-amber-500/15 text-amber-500" : "border-red-500/30 bg-red-500/15 text-red-500";
  return <Badge variant="outline" className={cn("tabular-nums", tone)}>{score}</Badge>;
}

export function ProspectFinderForm() {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [lookalikes, setLookalikes] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [batchName, setBatchName] = useState("");
  const [batchColor, setBatchColor] = useState("green");
  const [batchError, setBatchError] = useState(false);
  const [view, setView] = useState<View>("good");
  const [searchId, setSearchId] = useState<string | null>(null);
  const [data, setData] = useState<ListData | null>(null);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const running = useRef(false);
  const prefilled = useRef(false);

  const load = useCallback(async (sid = searchId, v = view) => {
    const q = new URLSearchParams({ view: v, ...(sid ? { search_id: sid } : {}) });
    const d = await api<ListData>(`/api/v1/prospects?${q}`);
    setData(d);
    if (!sid && d.search_id) setSearchId(d.search_id);
    // Coming back to the page: show the last search's filters, and its
    // progress if it's still running. Everything lives server-side, so
    // nothing restarts and nothing is lost by leaving.
    if (!prefilled.current && d.searches[0]) {
      prefilled.current = true;
      const f = d.searches[0].filters as { keywords?: string[]; locations?: string[]; employee_ranges?: string[]; lookalike_org_ids?: string[]; exclude_websites?: string[] };
      setKeywords(f.keywords ?? []); setCountries(f.locations ?? []); setSizes(f.employee_ranges ?? []);
      setLookalikes(f.lookalike_org_ids ?? []); setExclude(f.exclude_websites ?? []);
      if (!sid && d.counts.working > 0 && v === "good") setView("working");
    }
    return d;
  }, [searchId, view]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // While anything is still being read/scored/revealed, advance it and refresh.
  // In production the minute pump does the same; running both is safe (row locks).
  const pending = (data?.counts.working ?? 0) > 0 || (data?.companies ?? []).some((c) => ["good", "approved"].includes(c.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      if (running.current) return;
      running.current = true;
      try { await api("/api/v1/prospects/run", { method: "POST" }); await load(); } catch { /* next tick */ } finally { running.current = false; }
    }, 4000);
    return () => clearInterval(t);
  }, [pending, load]);

  async function runSearch() {
    if (!keywords.length) { setError("Add at least one keyword."); return; }
    if (!batchName.trim()) { setBatchError(true); setError("Give this batch a name so its leads are easy to find later."); return; }
    setError(""); setBatchError(false); setBusy(true);
    try {
      const out = await api<{ search_id: string }>("/api/v1/prospects/search", {
        method: "POST",
        body: { keywords, locations: countries.length ? countries : undefined, employee_ranges: sizes.length ? sizes : undefined,
          lookalike_org_ids: lookalikes.length ? lookalikes : undefined, exclude_websites: exclude.length ? exclude : undefined, page: 1,
          batch_name: batchName.trim(), color: batchColor },
      });
      setSearchId(out.search_id); setView("working"); setBatchName("");
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

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Find companies, let the AI score each one 1–10 from its website or LinkedIn, and reveal <b>one</b> contact only at good fits (7+). Scores 4–6 wait for your decision; 1–3 are hidden.
        </p>
        <TagInput label="Keywords" pills={keywords} suggestions={KEYWORD_SUGGESTIONS} onChange={setKeywords} placeholder="e.g. blown film" required tip="Apollo company keywords. Process words (blown film, injection molding) find real converters better than 'plastic'." />
        <LocationsPicker selected={countries} onChangeSelected={setCountries} />
        <TagInput label="Company size (employees)" pills={sizes} suggestions={SIZE_SUGGESTIONS} onChange={setSizes} allowCustom={false} placeholder="Any size" />
        <TagInput label="Lookalike companies (Apollo IDs)" pills={lookalikes} suggestions={[]} onChange={setLookalikes} max={5} placeholder="Optional — up to 5 best customers" tip="Apollo ranks results by similarity to these companies." />
        <TagInput label="Leave out websites" pills={exclude} suggestions={[]} onChange={setExclude} placeholder="Optional — e.g. competitor.com" />
        <BatchNameField value={batchName} onChange={(v) => { setBatchName(v); setBatchError(false); }} color={batchColor} onColorChange={setBatchColor} error={batchError} />
        <ApolloCostNote credits={1} spendingOn="one company search (up to 100 companies)" rate="1 credit per page of up to 100 companies. Reading and scoring don't use Apollo credits." mock={current?.mock} />
        {error && <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}
        <Button onClick={runSearch} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Search & score companies
        </Button>
      </div>

      {data && data.searches.length > 0 && (
        <div className="space-y-3 border-t border-border pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={searchId ?? undefined} onValueChange={(v) => { setSearchId(v); }}>
              <SelectTrigger className="h-9 w-80"><SelectValue placeholder="Pick a search" /></SelectTrigger>
              <SelectContent>
                {data.searches.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {new Date(s.created_at).toLocaleString()} · {(s.filters.keywords ?? []).join(", ")}{s.mock ? " (test)" : ""}
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

          {pending && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              <span>Reading and scoring {counts.working} compan{counts.working === 1 ? "y" : "ies"} in the background. You can close this window or change page; progress is saved and continues on its own.</span>
            </div>
          )}

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
        </div>
      )}
    </div>
  );
}
