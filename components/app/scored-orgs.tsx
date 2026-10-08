"use client";

// Scored companies in the Organizations tab: the running-searches bar, the
// Status/Batch filters, the review list (Approve / Decline / Retry) and the
// Kanban board. Data: GET /api/v1/prospects (lib/services/prospects/groups.ts
// decides each company's column and status line).
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Building2, Check, ChevronDown, ChevronUp, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { getToken } from "@/components/app/lead-forms";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getBatchColor } from "@/lib/constants";
import { GROUP_LABEL, GROUPS, statusLine, type Group, type Tone } from "@/lib/services/prospects/groups";
import { cn } from "@/lib/utils";

// ── data ─────────────────────────────────────────────────────────────────────
export interface ScoredSearch {
  id: string; batch_name: string; color: string; keywords: string[]; status: string; error: string | null;
  credits_spent: number; returned: number | null; new_companies: number | null; mock: boolean; created_at: string;
  max_auto_reveals: number | null; total: number; in_progress: number; groups: Record<Group, number>;
  stages: { found: number; read: number; scored: number; to_reveal: number; revealed: number; waiting_credits: number };
}
export interface ScoredCompany {
  id: string; search_id: string; name: string; domain: string | null; website_url: string | null; linkedin_url: string | null;
  status: string; score: number | null; reason: string | null; text_source: string | null; last_error: string | null; attempts: number;
  decided_by: string | null; organization_id: string | null; group: Group; batch_name: string; batch_color: string;
  contact: { first_name: string | null; title: string | null; email: string | null } | null;
}
export interface ScoredData { searches: ScoredSearch[]; counts: Record<Group, number>; companies: ScoredCompany[]; review_total: number }
export interface ScoredFilter { searchIds: string[]; groups: Group[]; hidden: boolean }
export const EMPTY_SCORED_FILTER: ScoredFilter = { searchIds: [], groups: [], hidden: false };
export const scoredFilterActive = (f: ScoredFilter) => f.searchIds.length > 0 || f.groups.length > 0 || f.hidden;

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

/** Loads scored companies for the filter; while anything is still being worked on it
 *  refreshes every 4 s and nudges the background job (the minute pump does the same
 *  in production — running both is safe, rows are locked). Network errors are shown,
 *  never thrown away: the last good data stays on screen. */
export function useScoredOrgs(filter: ScoredFilter, q: string, enabled = true) {
  const [data, setData] = useState<ScoredData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const kicking = useRef(false);
  const key = JSON.stringify({ filter, q });

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (filter.searchIds.length) p.set("search_ids", filter.searchIds.join(","));
    if (filter.groups.length) p.set("groups", filter.groups.join(","));
    if (filter.hidden) p.set("hidden", "1");
    if (q.trim()) p.set("q", q.trim());
    try {
      setData(await api<ScoredData>(`/api/v1/prospects?${p}`));
      setError(null);
    } catch (e) { setError((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load, enabled]);

  const busy = (data?.searches ?? []).some((s) => s.in_progress > 0 || s.stages.waiting_credits > 0);
  useEffect(() => {
    if (!enabled || !busy) return;
    const t = setInterval(() => {
      if (!kicking.current && (data?.searches ?? []).some((s) => s.in_progress > 0)) {
        kicking.current = true;
        api("/api/v1/prospects/run", {}).catch(() => {}).finally(() => { kicking.current = false; });
      }
      void load();
    }, 4000);
    return () => clearInterval(t);
  }, [enabled, busy, load, data]);

  return { data, error, loading, reload: load };
}

export async function decideScored(ids: string[], action: "approve" | "reject" | "retry") {
  const r = await api<{ changed: number; skipped: number }>("/api/v1/prospects/decide", { ids, action });
  const verb = action === "approve" ? "Approved" : action === "reject" ? "Declined" : "Retrying";
  toast.success(`${verb} ${r.changed} compan${r.changed === 1 ? "y" : "ies"}${r.skipped ? ` · ${r.skipped} had already moved on` : ""}`);
  return r;
}

// ── small pieces ─────────────────────────────────────────────────────────────
const TONE: Record<Tone, string> = {
  blue: "bg-primary/10 text-primary border-primary/20",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  gray: "bg-secondary text-muted-foreground border-border",
};
const GROUP_TONE: Record<Group, Tone> = { checking: "blue", review: "amber", good: "green", approved: "blue", declined: "gray", hidden: "gray" };

export function GroupPill({ group, status }: { group: Group; status?: string }) {
  const label = status === "site_down" ? "Website down" : GROUP_LABEL[group];
  return <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", TONE[status === "site_down" ? "red" : GROUP_TONE[group]])}>{label}</span>;
}

function FitPill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">–</span>;
  return <span className={cn("inline-flex rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums", TONE[score >= 7 ? "green" : "gray"])} title={score === 9 ? "Makes the searched products" : score === 7 ? "Other plastic products" : "Not a fit"}>{score}</span>;
}

function BatchPill({ name, color }: { name: string; color: string }) {
  return <span className={cn("inline-flex max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold", getBatchColor(color).pill)}>{name}</span>;
}

function Links({ c }: { c: ScoredCompany }) {
  const site = c.website_url ?? (c.domain ? `https://${c.domain}` : null);
  return (
    <span className="flex flex-wrap gap-x-2 text-[11px]">
      {site ? <a href={site} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-primary hover:underline">{c.domain ?? "Website"}<ExternalLink className="size-2.5" /></a> : <span className="text-muted-foreground">No website</span>}
      {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-primary hover:underline">LinkedIn<ExternalLink className="size-2.5" /></a>}
    </span>
  );
}

function Decide({ c, busy, onDecide }: { c: ScoredCompany; busy: boolean; onDecide: (ids: string[], a: "approve" | "reject" | "retry") => void }) {
  if (c.group !== "review" && c.status !== "hidden") return null;
  return (
    <span className="flex gap-1.5">
      {c.status === "site_down"
        ? <Button size="sm" variant="outline" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide([c.id], "retry"); }} className="h-7 gap-1 px-2 text-xs"><RotateCcw className="size-3" />Retry</Button>
        : <Button size="sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide([c.id], "approve"); }} className="h-7 gap-1 px-2 text-xs"><Check className="size-3" />Approve</Button>}
      {c.status !== "hidden" && <Button size="sm" variant="outline" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide([c.id], "reject"); }} className="h-7 gap-1 px-2 text-xs"><X className="size-3" />Decline</Button>}
    </span>
  );
}

// ── running searches bar ─────────────────────────────────────────────────────
function Stage({ label, done, total, tone = "bg-primary" }: { label: string; done: number; total: number; tone?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground"><span className="truncate">{label}</span><span className="font-mono tabular-nums">{done}/{total}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** One line while searches run (or need you); opens into per-search stages. Hidden when nothing is going on. */
export function RunningSearchesBar({ data, onOpen }: { data: ScoredData | null; onOpen: (searchId: string, group?: Group) => void }) {
  const [open, setOpen] = useState(false);
  const searches = data?.searches ?? [];
  const running = searches.filter((s) => s.in_progress > 0);
  const waiting = searches.filter((s) => s.stages.waiting_credits > 0);
  const failed = searches.filter((s) => s.status !== "done" && Date.now() - new Date(s.created_at).getTime() < 24 * 3600_000);
  const toReview = searches.filter((s) => s.groups.review > 0);
  if (!running.length && !waiting.length && !failed.length && !toReview.length) return null;
  const shown = searches.filter((s) => s.in_progress > 0 || s.stages.waiting_credits > 0 || s.groups.review > 0 || failed.includes(s)).slice(0, 6);

  return (
    <div className="rounded-xl border border-border bg-field dark:bg-card px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {running.length > 0 && <span className="flex items-center gap-1.5 font-semibold"><Loader2 className="size-3.5 animate-spin text-primary" />{running.length} search{running.length > 1 ? "es" : ""} running</span>}
        {running.slice(0, 2).map((s) => (
          <span key={s.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            {s.batch_name} · {s.stages.scored} of {s.total} checked
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"><span className="block h-full bg-primary" style={{ width: `${s.total ? (s.stages.scored / s.total) * 100 : 0}%` }} /></span>
          </span>
        ))}
        {waiting.length > 0 && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{waiting.reduce((t, s) => t + s.stages.waiting_credits, 0)} waiting for Apollo credits</span>}
        {failed.length > 0 && <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400"><AlertTriangle className="size-3.5" />{failed.length} search{failed.length > 1 ? "es" : ""} had a problem</span>}
        {(data?.review_total ?? 0) > 0 && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{data!.review_total} need review</span>}
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} className="ml-auto h-7 gap-1 text-xs">
          {open ? <>Hide <ChevronUp className="size-3.5" /></> : <>Details <ChevronDown className="size-3.5" /></>}
        </Button>
      </div>
      {open && (
        <div className="mt-2 divide-y divide-border border-t border-border">
          {shown.map((s) => (
            <div key={s.id} className="grid items-center gap-4 py-3 md:grid-cols-[1.3fr_repeat(4,minmax(0,1fr))_auto]">
              <div className="min-w-0">
                <BatchPill name={s.batch_name} color={s.color} />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {new Date(s.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {s.credits_spent} Apollo credit{s.credits_spent === 1 ? "" : "s"}{s.mock ? " · test" : ""}
                </p>
                {s.status === "failed" && <p className="text-[11px] font-medium text-red-600 dark:text-red-400">Search failed: {s.error}</p>}
                {s.status === "paying" && <p className="text-[11px] font-medium text-red-600 dark:text-red-400">{s.error ?? "Apollo didn't answer — charge unknown"}</p>}
              </div>
              <Stage label="Found" done={s.stages.found} total={s.stages.found} />
              <Stage label="Websites read" done={s.stages.read} total={s.stages.found} />
              <Stage label="AI checked" done={s.stages.scored} total={s.stages.found} />
              <Stage label="Contacts revealed" done={s.stages.revealed} total={s.stages.to_reveal} tone="bg-emerald-500" />
              <div className="flex flex-col items-end gap-1 text-xs">
                {s.groups.review > 0 && <Button type="button" variant="link" onClick={() => onOpen(s.id, "review")} className="h-auto p-0 text-xs text-amber-600 dark:text-amber-400">Review {s.groups.review} →</Button>}
                <Button type="button" variant="link" onClick={() => onOpen(s.id)} className="h-auto p-0 text-xs">Open batch →</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── filters ──────────────────────────────────────────────────────────────────
export function ScoredFiltersDialog({ open, onOpenChange, value, onApply, data }: {
  open: boolean; onOpenChange: (o: boolean) => void; value: ScoredFilter; onApply: (f: ScoredFilter) => void; data: ScoredData | null;
}) {
  const [draft, setDraft] = useState<ScoredFilter>(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const allCounts = (data?.searches ?? []).reduce((acc, s) => { for (const g of GROUPS) acc[g] += s.groups[g]; return acc; }, { checking: 0, review: 0, good: 0, approved: 0, declined: 0, hidden: 0 } as Record<Group, number>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Filter scored companies</DialogTitle></DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="eyebrow">Status</p>
            {GROUPS.filter((g) => g !== "hidden").map((g) => (
              <label key={g} className="flex cursor-pointer items-center gap-2 text-sm">
                <AppCheckbox checked={draft.groups.includes(g)} onClick={() => setDraft((d) => ({ ...d, groups: toggle(d.groups, g) }))} />
                {GROUP_LABEL[g]}<span className="ml-auto font-mono text-xs text-muted-foreground">{allCounts[g]}</span>
              </label>
            ))}
            <label className="flex items-center gap-2 pt-2 text-sm">
              <Switch checked={draft.hidden} onCheckedChange={(v) => setDraft((d) => ({ ...d, hidden: v }))} />
              Show hidden (not a plastic maker)<span className="ml-auto font-mono text-xs text-muted-foreground">{allCounts.hidden}</span>
            </label>
          </div>
          <div className="space-y-2">
            <p className="eyebrow">Batch</p>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {(data?.searches ?? []).map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <AppCheckbox checked={draft.searchIds.includes(s.id)} onClick={() => setDraft((d) => ({ ...d, searchIds: toggle(d.searchIds, s.id) }))} />
                  <span className={cn("size-2 shrink-0 rounded-full", getBatchColor(s.color).bg)} />
                  <span className="truncate">{s.batch_name}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{s.in_progress > 0 ? "running" : s.total}</span>
                </label>
              ))}
              {!data?.searches.length && <p className="text-sm text-muted-foreground">No scored searches yet.</p>}
            </div>
          </div>
        </div>
        <div className="flex justify-between border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={() => setDraft(EMPTY_SCORED_FILTER)}>Clear all</Button>
          <Button type="button" onClick={() => { onApply(draft); onOpenChange(false); }}>Apply</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Removable chips for the active filter, shown in the toolbar. */
export function ScoredFilterChips({ value, data, onChange }: { value: ScoredFilter; data: ScoredData | null; onChange: (f: ScoredFilter) => void }) {
  const name = (id: string) => data?.searches.find((s) => s.id === id)?.batch_name ?? "Batch";
  const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";
  return (
    <span className="flex flex-wrap gap-1.5">
      {value.searchIds.map((id) => <Button key={id} type="button" variant="ghost" onClick={() => onChange({ ...value, searchIds: value.searchIds.filter((x) => x !== id) })} className={cn(chip, "h-auto border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>Batch: {name(id)} <X className="size-3" /></Button>)}
      {value.groups.map((g) => <Button key={g} type="button" variant="ghost" onClick={() => onChange({ ...value, groups: value.groups.filter((x) => x !== g) })} className={cn(chip, "h-auto border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400")}>Status: {GROUP_LABEL[g]} <X className="size-3" /></Button>)}
      {value.hidden && <Button type="button" variant="ghost" onClick={() => onChange({ ...value, hidden: false })} className={cn(chip, "h-auto border-border text-muted-foreground")}>Showing hidden <X className="size-3" /></Button>}
    </span>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────
export function ScoredOrgsTable({ data, error, loading, onDecide, onOpenOrg }: {
  data: ScoredData | null; error: string | null; loading: boolean;
  onDecide: (ids: string[], a: "approve" | "reject" | "retry") => Promise<void>; onOpenOrg: (orgId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (ids: string[], a: "approve" | "reject" | "retry") => { setBusy(true); try { await onDecide(ids, a); } finally { setBusy(false); } };
  const rows = data?.companies ?? [];
  const reviewIds = rows.filter((c) => c.group === "review" && c.status !== "site_down").map((c) => c.id);

  if (!data && loading) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading scored companies…</div>;
  return (
    <div className="space-y-3">
      {error && <p className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"><AlertTriangle className="size-4" />Couldn&apos;t refresh: {error}. Showing the last loaded list; it retries on its own.</p>}
      {reviewIds.length > 0 && <ApolloCostNote credits={reviewIds.length} spendingOn={`revealing one contact at each of the ${reviewIds.length} companies you approve`} rate="1 credit per contact revealed. Retry on a website that was down uses 1 Firecrawl credit, not Apollo." />}
      <div className="w-full overflow-hidden rounded-xl border border-border bg-field shadow-sm dark:bg-card">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              {["Organization", "Status", "Fit", "Why", "Batch", "Leads", "Decide"].map((h) => (
                <TableHead key={h} className={cn("font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground", h === "Leads" && "text-right")}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="p-0"><EmptyState boxed={false} message="No companies match these filters." /></TableCell></TableRow>
            ) : rows.map((c) => {
              const line = statusLine(c);
              return (
                <TableRow key={c.id} onClick={() => c.organization_id && onOpenOrg(c.organization_id)} className={cn("border-border", c.organization_id && "cursor-pointer hover:bg-secondary")}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-secondary"><Building2 className="size-3.5 text-muted-foreground" /></div>
                      <div className="min-w-0"><p className="truncate text-sm font-semibold">{c.name}</p><Links c={c} /></div>
                    </div>
                  </TableCell>
                  <TableCell><GroupPill group={c.group} status={c.status} /></TableCell>
                  <TableCell><FitPill score={c.score} /></TableCell>
                  <TableCell className="max-w-sm"><p className="line-clamp-2 text-xs text-muted-foreground">{c.reason ?? "—"}</p><p className={cn("text-[11px]", line.tone === "red" ? "text-red-600 dark:text-red-400" : line.tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{line.text}</p></TableCell>
                  <TableCell className="max-w-40"><BatchPill name={c.batch_name} color={c.batch_color} /></TableCell>
                  <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">{c.status === "promoted" ? 1 : 0}</TableCell>
                  <TableCell><Decide c={c} busy={busy} onDecide={run} /></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {reviewIds.length > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(reviewIds, "reject")}>Decline all {reviewIds.length}</Button>
            <Button size="sm" disabled={busy} onClick={() => run(reviewIds, "approve")}>Approve all {reviewIds.length}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── kanban ───────────────────────────────────────────────────────────────────
const KANBAN_COLS: { id: Group; dot: string }[] = [
  { id: "checking", dot: "bg-primary" }, { id: "review", dot: "bg-amber-500" }, { id: "good", dot: "bg-emerald-500" },
  { id: "approved", dot: "bg-blue-500" }, { id: "declined", dot: "bg-muted-foreground" },
];

export function ScoredOrgsKanban({ data, error, loading, onDecide, onShowHidden, onOpenOrg }: {
  data: ScoredData | null; error: string | null; loading: boolean;
  onDecide: (ids: string[], a: "approve" | "reject" | "retry") => Promise<void>; onShowHidden: () => void; onOpenOrg: (orgId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (ids: string[], a: "approve" | "reject" | "retry") => { setBusy(true); try { await onDecide(ids, a); } finally { setBusy(false); } };
  if (!data && loading) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading scored companies…</div>;
  if (!data?.searches.length) return <EmptyState message="No scored searches yet. Use Add leads → Scored Companies to start one." />;
  const companies = data.companies;
  const checking = data.searches.filter((s) => s.in_progress > 0);

  return (
    <div className="space-y-3">
      {error && <p className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"><AlertTriangle className="size-4" />Couldn&apos;t refresh: {error}. It retries on its own.</p>}
      <div className="flex min-h-[500px] gap-2 overflow-x-auto pb-4">
        {KANBAN_COLS.map((col) => {
          const cards = companies.filter((c) => c.group === col.id);
          return (
            <div key={col.id} className="flex shrink-0 flex-col gap-2" style={{ width: "calc((100% - 120px) / 5)", minWidth: "200px" }}>
              <div className="swatch-bar flex items-center gap-1.5 overflow-hidden rounded-lg border bg-field px-2.5 py-2">
                <span className={cn("size-2 shrink-0 rounded-full", col.dot)} />
                <span className="eyebrow truncate text-foreground/80!">{GROUP_LABEL[col.id]}</span>
                <span className="ml-auto shrink-0 rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground">{data.counts[col.id]}</span>
              </div>
              {col.id === "checking" && checking.map((s) => (
                <div key={s.id} className="space-y-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                  <p className="truncate text-[11px] font-semibold">{s.batch_name}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-all" style={{ width: `${s.total ? (s.stages.scored / s.total) * 100 : 0}%` }} /></div>
                  <p className="font-mono text-[10px] text-muted-foreground">{s.stages.scored}/{s.total} checked</p>
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                {cards.slice(0, 60).map((c) => {
                  const line = statusLine(c);
                  return (
                    <div key={c.id} onClick={() => c.organization_id && onOpenOrg(c.organization_id)} className={cn("space-y-1.5 rounded-lg border bg-field p-2.5 shadow-sm", c.status === "site_down" ? "border-red-500/30" : c.group === "review" ? "border-amber-500/30" : "border-border", c.organization_id && "cursor-pointer hover:border-muted-foreground/50")}>
                      <div className="flex items-start justify-between gap-2"><p className="text-xs font-semibold leading-snug">{c.name}</p><FitPill score={c.score} /></div>
                      <Links c={c} />
                      <BatchPill name={c.batch_name} color={c.batch_color} />
                      <p className={cn("text-[11px] leading-snug", line.tone === "red" ? "text-red-600 dark:text-red-400" : line.tone === "amber" ? "text-amber-600 dark:text-amber-400" : line.tone === "green" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{line.text}</p>
                      <Decide c={c} busy={busy} onDecide={run} />
                    </div>
                  );
                })}
                {cards.length > 60 && <p className="text-center text-[11px] text-muted-foreground">+ {cards.length - 60} more — use the list view or a batch filter</p>}
                {cards.length === 0 && <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-6"><p className="text-[10px] text-muted-foreground/60">Empty</p></div>}
              </div>
            </div>
          );
        })}
        <div className="flex w-28 shrink-0 flex-col items-center gap-2 rounded-lg border border-dashed border-border px-2 py-3 text-center">
          <span className="eyebrow">Hidden</span>
          <span className="font-mono text-xl font-bold text-muted-foreground">{data.counts.hidden}</span>
          <Button type="button" variant="link" onClick={onShowHidden} className="h-auto p-0 text-xs">Show</Button>
        </div>
      </div>
    </div>
  );
}
