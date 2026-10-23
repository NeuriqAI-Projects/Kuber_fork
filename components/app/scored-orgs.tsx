"use client";

// Scored companies in the Organizations tab: the running-searches bar, the
// Status/Batch filters, the review list (Approve / Decline / Retry) and the
// Kanban board. Data: GET /api/v1/prospects (lib/services/prospects/groups.ts
// decides each company's column and status line).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Building2, Check, CheckCheck, ChevronDown, ChevronUp, CircleDot, ExternalLink, Gauge, Globe, Link2, Loader2,
  MessageSquareText, RotateCcw, Tag, Undo2, X, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { getToken } from "@/components/app/lead-forms";
import { Button } from "@/components/ui/button";
import { FilterModal } from "@/components/ui/filter-modal";
import { MultiSelectDropdown, type DropdownOption } from "@/components/ui/multi-select-dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoTip } from "@/components/ui/info-tip";
import { Tip } from "@/components/ui/tip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DomainLink } from "@/components/app/domain-link";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/ui/page-header";
import { DetailRow, DetailSection } from "@/components/ui/record-layout";
import { prefetchOrg } from "@/lib/api-client";
import { getBatchColor } from "@/lib/constants";
import { plainReason } from "@/lib/services/prospects/fit-rules";
import { GROUP_LABEL, GROUPS, plainCause, REVIEW_TOTAL_EVENT, statusLine, type Group, type Tone } from "@/lib/services/prospects/groups";
import { cn } from "@/lib/utils";

// ── data ─────────────────────────────────────────────────────────────────────
export interface ScoredSearch {
  id: string; batch_name: string; color: string; keywords: string[]; status: string; error: string | null;
  credits_spent: number; returned: number | null; new_companies: number | null; mock: boolean; created_at: string;
  max_auto_reveals: number | null; credits_used: number; max_credits: number | null;
  target_leads: number | null; leads: number; pages: number[]; run_status: string; run_note: string | null; total: number; in_progress: number; groups: Record<Group, number>;
  stages: { found: number; read: number; scored: number; to_reveal: number; revealed: number; waiting_credits: number };
}
export interface ScoredCompany {
  id: string; search_id: string; name: string; domain: string | null; website_url: string | null; linkedin_url: string | null;
  status: string; score: number | null; reason: string | null; text_source: string | null; last_error: string | null; attempts: number;
  decided_by: string | null; organization_id: string | null; group: Group; batch_name: string; batch_color: string;
  contact: { first_name: string | null; title: string | null; email: string | null } | null;
}
export interface ScoredData { searches: ScoredSearch[]; counts: Record<Group, number>; companies: ScoredCompany[]; review_total: number }
export type DecideAction = "approve" | "reject" | "retry" | "undo";
/** `waiting` = only "Waiting for credits" companies (a part of Good fit / Approved, not a column of its own). */
export interface ScoredFilter { searchIds: string[]; groups: Group[]; hidden: boolean; waiting?: boolean }
export const EMPTY_SCORED_FILTER: ScoredFilter = { searchIds: [], groups: [], hidden: false, waiting: false };
export const scoredFilterActive = (f: ScoredFilter) => f.searchIds.length > 0 || f.groups.length > 0 || f.hidden || !!f.waiting;
/** Number shown on the Filters button: how many filters are set (Status, Batch), like the Leads button. */
export const scoredFilterCount = (f: ScoredFilter) => (f.groups.length > 0 || f.hidden || f.waiting ? 1 : 0) + (f.searchIds.length > 0 ? 1 : 0);

async function api<T>(url: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // No message from our API (a crash, a proxy page): never show the bare HTTP code.
  if (!res.ok) throw new Error(json?.error?.message ?? "Kuber's server had a problem and did not answer. Try again in a minute.");
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
    // Hidden is just another Status option: the API returns ONLY the selected
    // groups, so it has to be in the list (alone, or beside the others).
    const groups = filter.hidden ? [...filter.groups, "hidden"] : filter.groups;
    if (groups.length) p.set("groups", groups.join(","));
    if (filter.hidden) p.set("hidden", "1");
    if (filter.waiting) p.set("waiting", "1");
    if (q.trim()) p.set("q", q.trim());
    try {
      const d = await api<ScoredData>(`/api/v1/prospects?${p}`);
      setData(d);
      // The side menu's "N to review" polls once a minute; give it this fresher number so both always match.
      window.dispatchEvent(new CustomEvent(REVIEW_TOTAL_EVENT, { detail: d.review_total }));
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
  // Idle pages still look every 15 s: a search started after this page loaded (Add Leads closed
  // mid-start, another tab, a teammate) must show up without a reload.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (busy && !kicking.current && (data?.searches ?? []).some((s) => s.in_progress > 0)) {
        kicking.current = true;
        api("/api/v1/prospects/run", {}).catch(() => {}).finally(() => { kicking.current = false; });
      }
      void load();
    }, busy ? 4000 : 15000);
    return () => clearInterval(t);
  }, [enabled, busy, load, data]);

  return { data, error, loading, reload: load };
}

export async function decideScored(ids: string[], action: DecideAction) {
  const r = await api<{ changed: number; skipped: number }>("/api/v1/prospects/decide", { ids, action });
  const verb = action === "approve" ? "Approved" : action === "reject" ? "Declined" : action === "undo" ? "Restored" : "Retrying";
  toast.success(`${verb} ${r.changed} compan${r.changed === 1 ? "y" : "ies"}${r.skipped ? ` · ${r.skipped} had already moved on` : ""}`);
  return r;
}

// ── small pieces ─────────────────────────────────────────────────────────────
const TONE: Record<Tone, string> = {
  blue: "bg-primary/10 text-primary border-primary/20",
  amber: "bg-amber-100 text-amber-800 border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200/70 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25",
  red: "bg-red-100 text-red-800 border-red-200/70 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25",
  gray: "bg-secondary text-muted-foreground border-border",
};

// ── Attio grid pieces (shared with the Leads page lists) ─────────────────────
// Built on the shared Table cells inside the caller's own scroll box (rather
// than <Table>, whose wrapper scrolls itself) so the header row and the first
// column can stick. `border-separate` keeps sticky cells' borders attached.
export const GRID_TABLE =
  "w-full border-separate border-spacing-0 text-[13px] [&_td]:whitespace-nowrap [&_td]:border-b [&_th]:border-b [&_td]:border-border [&_th]:border-border";
export const HEAD_CELL = "sticky top-0 z-20 bg-card";
/** A sticky body cell: opaque, follows the row's hover/selected tint (row needs `group`). */
/** Header of the Why column: the one column that stretches/shrinks to fit (see WhyCell). */
export const WHY_HEAD = "w-full min-w-[120px]";
/** Decide column sticks to the right edge, so Approve/Decline stay on screen even when extra
 *  columns make the grid scroll sideways. Header: DECIDE_HEAD, body cells: STICKY_CELL + "right-0". */
export const DECIDE_HEAD = "right-0 z-30 text-right";
export const STICKY_CELL =
  "sticky z-10 bg-card group-hover:bg-hover before:pointer-events-none before:absolute before:inset-0 group-data-[state=selected]:before:bg-primary/5";

/** Grid header cell: small icon + sentence-case label. */
export function ColHead({ icon: Icon, label, info, className }: { icon: LucideIcon; label: string; info?: string; className?: string }) {
  return (
    <TableHead className={cn(HEAD_CELL, className)}>
      <span className="inline-flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" />
        {label}
        {info && <InfoTip text={info} />}
      </span>
    </TableHead>
  );
}

/** 20px company tile for grid rows. */
export function OrgTile() {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-border bg-field text-muted-foreground">
      <Building2 className="size-3" />
    </span>
  );
}

/** The scored "Why" text and its status line, on one line (both in the hover title).
 *  `w-0 min-w-full`: the text never widens the column, so the Why column (WHY_HEAD) takes
 *  whatever room is left and the grid fits the screen instead of scrolling sideways. */
export function WhyCell({ reason, line }: { reason: string | null; line: { text: string; tone: Tone } | null }) {
  const warn = line && (line.tone === "red" || line.tone === "amber");
  return (
    <div className="flex w-0 min-w-full items-center gap-2" title={[plainReason(reason), line?.text].filter(Boolean).join("\n")}>
      {warn && (
        <span className={cn("max-w-[50%] shrink-0 truncate text-xs font-medium", line.tone === "red" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-300")}>
          {line.text}
        </span>
      )}
      <span className="min-w-0 truncate text-muted-foreground">{plainReason(reason) ?? (warn ? "" : line?.text ?? "—")}</span>
    </div>
  );
}
const STATUS_DOT: Record<Group, string> = { checking: "bg-primary", review: "bg-amber-500", good: "bg-emerald-500", approved: "bg-blue-500", declined: "bg-muted-foreground", hidden: "bg-muted-foreground/50" };
const GROUP_TONE: Record<Group, Tone> = { checking: "blue", review: "amber", good: "green", approved: "blue", declined: "gray", hidden: "gray" };

export function GroupPill({ group, status }: { group: Group; status?: string }) {
  const label = status === "site_down" ? "Website down" : GROUP_LABEL[group];
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-[3px] text-[11px] font-medium leading-none whitespace-nowrap", TONE[status === "site_down" ? "red" : GROUP_TONE[group]])}>{label}</span>;
}

/** Short label for a problem pill; the exact message goes in the hover title. */
function problemLabel(c: ScoredCompany, text: string): string {
  if (c.status === "site_down") return "Website down";
  if (text.startsWith("Retrying")) return "Retrying";
  if (c.status === "flagged") return "Not enough info";
  if (c.status === "review" && !c.last_error) return "AI unsure";
  if (c.status === "waiting_credits") return "Waiting for credits";
  return "Error";
}

export function FitPill({ score, group }: { score: number | null; group?: Group }) {
  // Needs review = the AI could not decide, so there is no number: show a "?" for "your call", not a blank.
  if (score == null && group === "review") return <Tip text="No fit score: the AI could not tell if it makes plastic products. Your call: Approve or Decline."><span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", TONE.amber)}>?</span></Tip>;
  if (score == null) return <Tip text="Not scored yet."><span className="text-xs text-muted-foreground">–</span></Tip>;
  const tip = score === 9 ? "Fit score 9: makes the products you searched." : score === 7 ? "Fit score 7: makes other plastic products." : `Fit score ${score}: not a fit.`;
  // A circle in the primary shade for a real fit (7+); neutral for the rest.
  return <Tip text={tip}><span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums", score >= 7 ? "border-primary/25 bg-primary/10 text-primary" : TONE.gray)}>{score}</span></Tip>;
}

export function BatchPill({ name, color, wide = false }: { name: string; color: string; wide?: boolean }) {
  // Only as wide as its text; a long name is cut with "…" (full name on hover).
  return <Tip text={`Batch: ${name.replace(/^Batch: /, "")}`} className={wide ? "max-w-full" : "max-w-[130px]"}><span className={cn("inline-flex w-fit min-w-0 max-w-full items-center rounded-[5px] border px-1.5 py-[3px] text-xs font-medium leading-none", getBatchColor(color).pill)}><span className="truncate">{name}</span></span></Tip>;
}

function Links({ c, linkedin = true }: { c: ScoredCompany; linkedin?: boolean }) {
  const site = c.website_url ?? (c.domain ? `https://${c.domain}` : null);
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {site ? <Tip text="Open the company website in a new tab."><a href={site} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-0.5 text-primary hover:underline"><span className="truncate">{c.domain ?? "Website"}</span><ExternalLink className="size-2.5 shrink-0" /></a></Tip> : <span className="text-muted-foreground">No website</span>}
      {linkedin && c.linkedin_url && <Tip text="Open the LinkedIn page in a new tab."><a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-primary hover:underline">LinkedIn<ExternalLink className="size-2.5" /></a></Tip>}
    </span>
  );
}

/** Whether <Decide> shows any button for this company. */
export const canDecide = (c: ScoredCompany) => c.status === "rejected" || c.group === "review" || c.status === "hidden";

export function Decide({ c, busy, onDecide, large = false }: { c: ScoredCompany; busy: boolean; onDecide: (ids: string[], a: DecideAction) => void; large?: boolean }) {
  const act = (a: DecideAction) => (e: React.MouseEvent) => { e.stopPropagation(); onDecide([c.id], a); };
  // `large` = the drawer footer: full-width, taller buttons. Cards keep the compact size.
  const btn = large ? "h-9 flex-1 gap-1.5 px-4 text-[13px] [&_svg]:size-4" : "h-6 gap-1 px-2 text-xs [&_svg]:size-3";
  const row = large ? "flex gap-2" : "flex justify-end gap-1.5";
  if (c.status === "rejected") {
    return <span className={large ? "flex" : "flex justify-end"}><Tip text="Put it back where it was before the Decline." className={large ? "flex-1" : undefined}><Button size="sm" variant="outline" disabled={busy} onClick={act("undo")} className={cn(btn, "w-full border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10 dark:hover:text-amber-200")}><Undo2 />Undo</Button></Tip></span>;
  }
  if (!canDecide(c)) return null;
  return (
    <span className={row}>
      {c.status === "site_down"
        ? <Tip text="Read the website again (1 Firecrawl credit)." className={large ? "flex-1" : undefined}><Button size="sm" variant="outline" disabled={busy} onClick={act("retry")} className={cn(btn, "w-full")}><RotateCcw />Retry{large ? " · 1 Firecrawl credit" : ""}</Button></Tip>
        : <Tip text="Reveal one contact at this company: 1 Apollo credit, only if Apollo has a person with an email there." className={large ? "flex-1" : undefined}><Button size="sm" disabled={busy} onClick={act("approve")} className={cn(btn, "w-full")}><Check />Approve{large ? " · 1 credit" : ""}</Button></Tip>}
      <Tip text="Skip this company. You can undo it." className={large ? "flex-1" : undefined}><Button size="sm" variant="outline" disabled={busy} onClick={act("reject")} className={cn(btn, "w-full")}><X />Decline</Button></Tip>
    </span>
  );
}

// ── running searches bar ─────────────────────────────────────────────────────
function Stage({ label, done, total, tone = "bg-primary" }: { label: string; done: number; total: number; tone?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground"><span className="truncate">{label}</span><span className="tabular-nums">{done}/{total}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** One search's progress and links (found / read / checked / revealed). Used by the running-search
 *  popover and by the details of the needs-attention bar, so they always match. */
function SearchRow({ s, onOpen }: { s: ScoredSearch; onOpen: (searchId: string, group?: Group) => void }) {
  return (
    <div className="grid items-center gap-4 py-3 md:grid-cols-[1.3fr_repeat(4,minmax(0,1fr))_auto]">
      <div className="min-w-0">
        <BatchPill name={s.batch_name} color={s.color} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {new Date(s.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {s.credits_used} Apollo credit{s.credits_used === 1 ? "" : "s"} used{s.max_credits != null ? ` (limit ${s.max_credits})` : ""}
        </p>
        {s.target_leads != null && (
          <p className="text-[11px] text-muted-foreground">
            <b className="text-foreground">{s.leads} of {s.target_leads} leads</b> · {s.pages.length} page{s.pages.length === 1 ? "" : "s"} read{s.pages.length ? ` (${s.pages.join(", ")})` : ""}{s.run_note && !(s.error && s.run_note.endsWith(s.error)) ? ` · ${s.run_note}` : ""}
          </p>
        )}
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
  );
}

/** "N searches running" as a compact button for the top toolbar (left of List | Kanban). Clicking it
 *  opens each running search's progress. Shows nothing when no search is running. */
export function RunningSearchesPill({ data, onOpen }: { data: ScoredData | null; onOpen: (searchId: string, group?: Group) => void }) {
  const running = (data?.searches ?? []).filter((s) => s.in_progress > 0);
  if (!running.length) return null;
  // Summed over every running search, so the number matches the "N searches" beside it.
  const checked = running.reduce((t, s) => t + s.stages.scored, 0);
  const found = running.reduce((t, s) => t + s.total, 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          {running.length} search{running.length > 1 ? "es" : ""} running
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{checked} of {found} companies checked</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(46rem,92vw)] p-4">
        <p className="mb-1 text-xs text-muted-foreground">Running now</p>
        <div className="divide-y divide-border">
          {running.slice(0, 4).map((s) => <SearchRow key={s.id} s={s} onOpen={onOpen} />)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The bar under the toolbar is only for what needs you: waiting for credits, a problem, or companies to
 *  review. A search that is simply running is the toolbar button's job. Hidden when nothing needs you. */
export function RunningSearchesBar({ data, onOpen }: { data: ScoredData | null; onOpen: (searchId: string, group?: Group) => void }) {
  const [open, setOpen] = useState(false);
  const searches = data?.searches ?? [];
  const waiting = searches.filter((s) => s.stages.waiting_credits > 0);
  const failed = searches.filter((s) => s.status !== "done" && Date.now() - new Date(s.created_at).getTime() < 24 * 3600_000);
  const toReview = searches.filter((s) => s.groups.review > 0);
  if (!waiting.length && !failed.length && !toReview.length) return null;
  const shown = searches.filter((s) => s.stages.waiting_credits > 0 || s.groups.review > 0 || failed.includes(s)).slice(0, 6);

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(data?.review_total ?? 0) > 0 && <span title="Companies in your 20 most recent searches that wait for your Approve or Decline" className="text-xs font-medium text-amber-600 dark:text-amber-400">{data!.review_total} need review</span>}
        {waiting.length > 0 && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{waiting.reduce((t, s) => t + s.stages.waiting_credits, 0)} waiting for Apollo credits</span>}
        {failed.length > 0 && <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400"><AlertTriangle className="size-3.5" />{failed.length} search{failed.length > 1 ? "es" : ""} had a problem</span>}
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} className="ml-auto text-muted-foreground">
          {open ? <>Hide <ChevronUp className="size-3.5" /></> : <>Details <ChevronDown className="size-3.5" /></>}
        </Button>
      </div>
      {open && (
        <div className="mt-2 divide-y divide-border border-t border-border">
          {shown.map((s) => <SearchRow key={s.id} s={s} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

// ── filters ──────────────────────────────────────────────────────────────────
/** Mounted only while open (see the caller), so `draft` starts as a fresh copy of the applied filter
 *  every time. Picking things edits the draft only; nothing changes behind the dialog until Apply. */
export function ScoredFiltersDialog({ onOpenChange, value, onApply, data }: {
  onOpenChange: (o: boolean) => void; value: ScoredFilter; onApply: (f: ScoredFilter) => void; data: ScoredData | null;
}) {
  const [draft, setDraft] = useState<ScoredFilter>(() => ({ searchIds: [...value.searchIds], groups: [...value.groups], hidden: value.hidden, waiting: !!value.waiting }));
  const allCounts = (data?.searches ?? []).reduce((acc, s) => { for (const g of GROUPS) acc[g] += s.groups[g]; return acc; }, { checking: 0, review: 0, good: 0, approved: 0, declined: 0, hidden: 0 } as Record<Group, number>);

  // "Hidden" is one more Status option in the dropdown (same as the Leads
  // filter's single Status list); it maps to the `hidden` flag, which adds the
  // Hidden column to the Kanban.
  const waitingCount = (data?.searches ?? []).reduce((t, s) => t + s.stages.waiting_credits, 0);
  const statusOptions: DropdownOption<Group | "waiting">[] = [
    ...GROUPS.map((g) => ({ value: g, label: `${GROUP_LABEL[g]} (${allCounts[g]})`, chip: GROUP_LABEL[g], dot: STATUS_DOT[g] })),
    { value: "waiting", label: `Waiting for credits (${waitingCount})`, chip: "Waiting for credits", dot: "bg-amber-500" },
  ];
  const statusSelected = new Set<Group | "waiting">([...draft.groups, ...(draft.hidden ? (["hidden"] as const) : []), ...(draft.waiting ? (["waiting"] as const) : [])]);
  const batchOptions: DropdownOption<string>[] = (data?.searches ?? []).map((s) => ({
    value: s.id, label: `${s.batch_name} (${s.in_progress > 0 ? "running" : s.total})`, chip: s.batch_name, dot: getBatchColor(s.color).bg,
  }));

  return (
    <FilterModal
      onClose={() => onOpenChange(false)}
      onClear={() => setDraft(EMPTY_SCORED_FILTER)}
      onApply={() => { onApply(draft); onOpenChange(false); }}
    >
      <MultiSelectDropdown
        label="Status"
        hint="Show only companies in these stages. The numbers count your 20 most recent searches (the ones this page lists)."
        options={statusOptions}
        selected={statusSelected}
        onChange={(next) => setDraft((d) => ({ ...d, groups: [...next].filter((g): g is Group => g !== "hidden" && g !== "waiting"), hidden: next.has("hidden"), waiting: next.has("waiting") }))}
      />
      {batchOptions.length > 0 && (
        <MultiSelectDropdown
          label="Batch"
          hint="Show only companies from these searches."
          options={batchOptions}
          selected={new Set(draft.searchIds)}
          onChange={(next) => setDraft((d) => ({ ...d, searchIds: [...next] }))}
        />
      )}
    </FilterModal>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────
/** Optional columns of the scored list (Organization, Status, Fit and Decide are always there).
 *  LinkedIn is off by default: it is rarely needed and costs width the Why column needs. */
export const SCORED_COLUMN_DEFS = [
  { key: "domain", label: "Domain", defaultVisible: true },
  { key: "linkedin", label: "LinkedIn", defaultVisible: false },
  { key: "why", label: "Why", defaultVisible: true },
  { key: "batch", label: "Batch", defaultVisible: true },
] as const;
export type ScoredColKey = (typeof SCORED_COLUMN_DEFS)[number]["key"];
export type ScoredColVisibility = Record<ScoredColKey, boolean>;
export const DEFAULT_SCORED_VISIBILITY = Object.fromEntries(SCORED_COLUMN_DEFS.map((c) => [c.key, c.defaultVisible])) as ScoredColVisibility;

export function ScoredOrgsTable({ data, error, loading, visible = DEFAULT_SCORED_VISIBILITY, onDecide, onOpenCompany }: {
  data: ScoredData | null; error: string | null; loading: boolean; visible?: ScoredColVisibility;
  onDecide: (ids: string[], a: DecideAction) => Promise<void>; onOpenCompany: (c: ScoredCompany) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (ids: string[], a: DecideAction) => { setBusy(true); try { await onDecide(ids, a); } finally { setBusy(false); } };
  const rows = data?.companies ?? [];
  const reviewIds = rows.filter((c) => c.group === "review" && c.status !== "site_down").map((c) => c.id);

  if (!data && loading) return <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading scored companies…</div>;
  const cols: { label: string; icon: LucideIcon; show: boolean; className?: string }[] = [
    { label: "Status", icon: CircleDot, show: true },
    { label: "Fit", icon: Gauge, show: true },
    { label: "Domain", icon: Globe, show: visible.domain },
    { label: "LinkedIn", icon: Link2, show: visible.linkedin },
    { label: "Why", icon: MessageSquareText, show: visible.why, className: WHY_HEAD },
    { label: "Batch", icon: Tag, show: visible.batch },
    { label: "Decide", icon: CheckCheck, show: true, className: DECIDE_HEAD },
  ];
  return (
    <div>
      {(error || reviewIds.length > 0) && (
        <div className="space-y-3 px-4 py-3">
          {error && <p className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle className="size-4" />Couldn&apos;t refresh: {error}. Showing the last loaded list; it retries on its own.</p>}
          {reviewIds.length > 0 && <ApolloCostNote credits={reviewIds.length} spendingOn={`revealing one contact at each of the ${reviewIds.length} companies you approve`} rate="1 credit per contact revealed. Retry on a website that was down uses 1 Firecrawl credit, not Apollo." />}
        </div>
      )}
      <table className={cn(GRID_TABLE, (error || reviewIds.length > 0) && "border-t border-border")}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <ColHead icon={Building2} label="Organization" className="left-0 z-30 min-w-[200px]" />
            {cols.filter((c) => c.show).map((c) => <ColHead key={c.label} icon={c.icon} label={c.label} className={c.className} />)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent"><TableCell colSpan={8} className="border-r-0 p-0"><EmptyState boxed={false} icon={Building2} title="No companies" message="No companies match these filters." /></TableCell></TableRow>
          ) : rows.map((c) => {
            const line = statusLine(c);
            return (
              <TableRow
                key={c.id}
                onClick={() => onOpenCompany(c)}
                onMouseEnter={() => { if (c.organization_id) prefetchOrg(c.organization_id); }}
                className="group cursor-pointer"
              >
                <TableCell className={cn(STICKY_CELL, "left-0")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <OrgTile />
                    <span className="max-w-[160px] truncate font-medium" title={c.name}>{c.name}</span>
                  </div>
                </TableCell>
                <TableCell><GroupPill group={c.group} status={c.status} /></TableCell>
                <TableCell><FitPill score={c.score} group={c.group} /></TableCell>
                {visible.domain && <TableCell><DomainLink text={c.domain} href={c.website_url} /></TableCell>}
                {visible.linkedin && <TableCell><DomainLink text={c.linkedin_url ? "LinkedIn" : null} href={c.linkedin_url} tip="Open the LinkedIn page in a new tab." /></TableCell>}
                {visible.why && <TableCell><WhyCell reason={c.reason} line={line} /></TableCell>}
                {visible.batch && <TableCell><BatchPill name={c.batch_name} color={c.batch_color} /></TableCell>}
                <TableCell className={cn(STICKY_CELL, "right-0")}><Decide c={c} busy={busy} onDecide={run} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </table>
      {/* Room under the last row, so its Decide buttons can scroll clear of the floating "Ask Kuber AI" button. */}
      <div aria-hidden className="h-16" />
      {/* pr-28 keeps the buttons clear of the floating "Ask Kuber AI" button (bottom-right). */}
      {reviewIds.length > 1 && (
        <div className="sticky bottom-0 z-20 flex items-center justify-end gap-2 border-t border-border bg-background py-2 pl-4 pr-28">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(reviewIds, "reject")}>Decline all {reviewIds.length}</Button>
          <Button size="sm" disabled={busy} onClick={() => run(reviewIds, "approve")}>Approve all {reviewIds.length} · up to {reviewIds.length} credit{reviewIds.length === 1 ? "" : "s"}</Button>
        </div>
      )}
    </div>
  );
}

// ── kanban ───────────────────────────────────────────────────────────────────
const KANBAN_COLS: { id: Group; dot: string }[] = [
  { id: "checking", dot: "bg-primary" }, { id: "review", dot: "bg-amber-500" }, { id: "good", dot: "bg-emerald-500" },
  { id: "approved", dot: "bg-blue-500" }, { id: "declined", dot: "bg-muted-foreground" },
];
// Only shown when "Hidden" is picked in Filters > Status.
const HIDDEN_COL: { id: Group; dot: string } = { id: "hidden", dot: "bg-muted-foreground/50" };
const COL_TIP: Record<Group, string> = {
  checking: "We're reading the company's website (or LinkedIn if the site is down) and an AI is scoring whether they make plastic products.",
  review: "The AI wasn't sure, or couldn't read the site. Approve to add a contact, or Decline.",
  good: "The AI is confident they make what you searched. A contact is found automatically.",
  approved: "Approved, so one contact is revealed and added as a lead (uses 1 Apollo credit).",
  declined: "You declined these. Nothing is spent. Undo sends one back to Needs review.",
  hidden: "The AI thinks these aren't plastic makers. Approve one if it got it wrong.",
};

export function ScoredOrgsKanban({ data, error, loading, groups, showHidden, onDecide, onOpenCompany }: {
  data: ScoredData | null; error: string | null; loading: boolean; groups: Group[]; showHidden: boolean;
  onDecide: (ids: string[], a: DecideAction) => Promise<void>; onOpenCompany: (c: ScoredCompany) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (ids: string[], a: DecideAction) => { setBusy(true); try { await onDecide(ids, a); } finally { setBusy(false); } };
  if (!data && loading) return <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading scored companies…</div>;
  if (!data?.searches.length) return <EmptyState icon={Building2} title="No scored searches yet" message="Use Add leads → Scored companies to start one." />;
  const companies = data.companies;
  const checking = data.searches.filter((s) => s.in_progress > 0);
  // Nothing picked in Status -> the five normal columns. Otherwise ONLY the
  // picked ones (Hidden included if picked), so an unselected column never
  // sits there empty under a header that still shows its real count.
  const picked = [...KANBAN_COLS, HIDDEN_COL].filter((c) => (c.id === "hidden" ? showHidden : groups.includes(c.id)));
  const cols = picked.length ? picked : KANBAN_COLS;

  return (
    <div className="space-y-3">
      {error && <p className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle className="size-4" />Couldn&apos;t refresh: {error}. It retries on its own.</p>}
      {/* Fixed grid, no horizontal scroll: equal columns always fit the page width. */}
      <div className="grid min-h-[500px] items-start gap-3 pb-4" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((col) => {
          const cards = companies.filter((c) => c.group === col.id);
          return (
            <div key={col.id} className="flex min-w-0 flex-col gap-2">
              <div className="flex h-8 items-center gap-2 px-1">
                <span className={cn("size-2 shrink-0 rounded-full", col.dot)} />
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{GROUP_LABEL[col.id]}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{data.counts[col.id]}</span>
                <InfoTip text={COL_TIP[col.id]} />
              </div>
              {col.id === "checking" && checking.map((s) => (
                <div key={s.id} className="space-y-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                  <p className="truncate text-xs font-medium">{s.batch_name}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-[width]" style={{ width: `${s.total ? (s.stages.scored / s.total) * 100 : 0}%` }} /></div>
                  <p className="text-xs tabular-nums text-muted-foreground">{s.stages.scored}/{s.total} checked</p>
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                {cards.slice(0, 60).map((c) => {
                  const line = statusLine(c);
                  // Only say something when it needs the reader: a problem, a retry, or
                  // a company still being checked. "Contact: …", "Declined", "Not a
                  // plastic maker" just repeat the column or add noise.
                  const showLine = col.id === "checking" || col.id === "review" || line.tone === "red" || line.tone === "amber";
                  return (
                    <div
                      key={c.id}
                      onClick={() => onOpenCompany(c)}
                      onMouseEnter={() => { if (c.organization_id) prefetchOrg(c.organization_id); }}
                      className={cn("flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 shadow-xs transition-colors hover:bg-hover", c.status === "site_down" ? "border-red-300 dark:border-red-500/40" : c.group === "review" ? "border-amber-300 dark:border-amber-500/40" : "border-border")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2"><OrgTile /><p className="line-clamp-2 text-[13px] font-medium leading-snug">{c.name}</p></div>
                        <FitPill score={c.score} group={c.group} />
                      </div>
                      <Links c={c} linkedin={false} />
                      {/* Batch and status/problem pill share one line (wrapping only when they must). */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <BatchPill name={c.batch_name} color={c.batch_color} />
                        {showLine && (line.tone === "amber" || line.tone === "red"
                          // A problem is a small pill; the full message shows instantly on hover (InfoTip) and in the drawer.
                          ? <InfoTip text={problemLabel(c, line.text) === "AI unsure" ? "The AI couldn't decide, so it's your call." : line.text} triggerClassName={cn("w-fit cursor-help gap-1 rounded border px-1.5 py-[3px] text-[11px] font-medium leading-none", TONE[line.tone])}><AlertTriangle className="size-3 shrink-0" /><span className="truncate">{problemLabel(c, line.text)}</span></InfoTip>
                          : <span className="text-xs leading-snug text-muted-foreground">{line.text}</span>)}
                      </div>
                      {(c.status === "rejected" || c.group === "review" || c.status === "hidden") && <div className="mt-auto"><Decide c={c} busy={busy} onDecide={run} /></div>}
                    </div>
                  );
                })}
                {cards.length > 60 && <p className="text-center text-xs text-muted-foreground">+ {cards.length - 60} more — use the list view or a batch filter</p>}
                {cards.length === 0 && <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-6"><p className="text-xs text-muted-foreground">Empty</p></div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── drawer for a scored company that is not an organization yet ──────────────
/** Status line, the AI's reason and the last problem of a scored company. Shared by
 *  the scored-company drawer and the org drawer (orgs that came from a scored search). */
export function ScoredStatus({ c }: { c: ScoredCompany }) {
  const line = statusLine(c);
  return (
    <>
      <p className="text-xs text-muted-foreground">Status</p>
      <p className={cn("text-sm", line.tone === "red" ? "text-red-600 dark:text-red-400" : line.tone === "amber" ? "text-amber-700 dark:text-amber-300" : "text-foreground")}>{line.text}</p>
      {c.reason && (
        <>
          <p className="flex items-center gap-1 pt-2 text-xs text-muted-foreground">Why this score <InfoTip text="The AI's short reason for the score." side="right" /></p>
          <p className="text-sm leading-relaxed">{plainReason(c.reason)}</p>
        </>
      )}
      {c.last_error && c.last_error !== line.text && (
        <>
          {/* Plain cause for people; the raw service text stays in the tip for whoever debugs it. */}
          <p className="flex items-center gap-1 pt-2 text-xs text-muted-foreground">Last problem <InfoTip text={c.last_error} side="right" /></p>
          <p className="text-[13px] text-amber-700 dark:text-amber-300">{/^Website /i.test(c.last_error) ? "The company's website could not be read." : /HTTP|\(mock\)|JEV_|timeout|aborted|network|fetch failed|ECONN/i.test(c.last_error) ? `${plainCause(c.last_error).replace(/^./, (x) => x.toUpperCase())}.` : c.last_error}</p>
        </>
      )}
    </>
  );
}

/** Everything we know about a scored company, in the same right-hand record sheet
 *  as an organization. Used for companies that have no organization yet (not
 *  approved / no contact added) — approved ones open the normal org drawer. */
export function ScoredCompanyDrawer({ company, onClose, onDecide, onFilterBatch }: {
  company: ScoredCompany | null; onClose: () => void; onDecide: (ids: string[], a: DecideAction) => Promise<void>;
  /** Clicking the batch filters the board to that batch. */
  onFilterBatch: (searchId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  const c = company;
  const run = async (ids: string[], a: DecideAction) => { setBusy(true); try { await onDecide(ids, a); } finally { setBusy(false); } };
  const site = c ? (c.website_url ?? (c.domain ? `https://${c.domain}` : null)) : null;
  const line = c ? statusLine(c) : null;
  if (!c || !line) return null;
  const hasDecide = canDecide(c);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/25 dark:bg-black/60" onClick={onClose} />
      <div role="dialog" aria-label={c.name} className="fixed right-0 top-0 z-60 flex h-full w-[min(560px,95vw)] flex-col border-l border-border bg-background shadow-xl">
        <PageHeader
          crumbs={[{ icon: <Building2 />, label: "Scored company" }, { label: c.name }]}
          actions={<Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="text-muted-foreground"><X className="size-4" /></Button>}
        />
        <div className="flex shrink-0 items-start gap-3 px-6 pb-4 pt-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-field text-muted-foreground"><Building2 className="size-[18px]" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold leading-tight">{c.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <GroupPill group={c.group} status={c.status} />
              <FitPill score={c.score} group={c.group} />
              <button type="button" onClick={() => onFilterBatch(c.search_id)} aria-label="Show only this batch" className="max-w-full cursor-pointer text-left hover:opacity-80"><BatchPill name={`Batch: ${c.batch_name}`} color={c.batch_color} wide /></button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <div className="space-y-2 px-6 py-4">
            <ScoredStatus c={c} />
          </div>
          <DetailSection title="Record details" className="border-t border-border px-6">
            <DetailRow icon={<Tag />} label="Batch">
              <Tip text="Click to show only this batch."><button type="button" onClick={() => onFilterBatch(c.search_id)} className="cursor-pointer truncate text-left text-primary hover:underline">{c.batch_name}</button></Tip>
            </DetailRow>
            {c.domain && <DetailRow icon={<Globe />} label="Domain">{site ? <a href={site} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"><span className="truncate">{c.domain}</span><ExternalLink className="size-3 shrink-0" /></a> : c.domain}</DetailRow>}
            {c.linkedin_url && <DetailRow icon={<Link2 />} label="LinkedIn"><a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline" title={c.linkedin_url}><span className="truncate">{c.linkedin_url}</span><ExternalLink className="size-3 shrink-0" /></a></DetailRow>}
            {c.text_source && <DetailRow icon={<MessageSquareText />} label={<span className="inline-flex items-center gap-1">Read from <InfoTip text="Where the text came from: the website or LinkedIn." side="right" /></span>}><span className="text-muted-foreground">{c.text_source}</span></DetailRow>}
            {c.contact && (c.contact.first_name || c.contact.email) && (
              <DetailRow icon={<CircleDot />} label="Contact">
                <span title={[c.contact.first_name, c.contact.title, c.contact.email].filter(Boolean).join(" · ")}>
                  {[c.contact.first_name, c.contact.title].filter(Boolean).join(", ")}
                  {c.contact.email && <span className="text-muted-foreground"> · {c.contact.email}</span>}
                </span>
              </DetailRow>
            )}
            {c.attempts > 0 && <DetailRow icon={<RotateCcw />} label={<span className="inline-flex items-center gap-1">Attempts <InfoTip text="How many times we tried to read this company." side="right" /></span>}><span className="tabular-nums">{c.attempts}</span></DetailRow>}
          </DetailSection>
        </div>
        {hasDecide && <div className="shrink-0 border-t border-border p-4"><Decide c={c} busy={busy} onDecide={run} large /></div>}
      </div>
    </>
  );
}
