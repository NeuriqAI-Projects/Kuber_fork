"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef, Fragment } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2, Globe2, Mail, Megaphone, Users, X,
  Loader2, RefreshCw, CheckCircle2, AlertCircle, Clock,
  RotateCcw, Zap, Bot, Settings, Pencil, Phone,
  MapPin, ChevronRight, UserCog, Check, MessageSquare,
  XCircle, Send, MailCheck, MailOpen, Reply, Sparkles, BellOff, ArrowUp,
  User, LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatChatDate, startsNewChatDay } from "@/lib/chat-format";
import { useApp } from "@/lib/app-context";
import type { Lead, EnrichmentStage, LeadStatus } from "@/lib/leads";
import { Avatar, ScoreBadge, StatusBadge } from "@/components/leads/lead-ui";
import {
  fetchLead, fetchLeadActivity, fetchLeadComments, patchLead, patchOrg,
  postLeadComment, toggleLeadCommentReaction, rescrapeOrg, fetchServiceHealth,
  queryCache, cacheKeys, cachedFetchers, useCached,
  type Profile, type LeadActivityEvent, type LeadComment,
} from "@/lib/api-client";
import { DiscussionComment } from "@/components/app/discussion-comment";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecordLayout, RecordHeader, DetailSection, DetailRow } from "@/components/ui/record-layout";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnrichLog {
  event: string;
  source: string;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

interface EnrichStatus {
  enrichment_stage: EnrichmentStage | null;
  enrichment_status: string | null;
  enrichment_attempts: number;
  company_description: string | null;
  sells_to: string | null;
  last_error: string | null;
  logs: EnrichLog[];
}

// ── Event label map ───────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  SCRAPE_QUEUED:               "Queued for enrichment",
  SCRAPE_BATCH_STARTED:        "Batch processing started",
  SCRAPE_STARTED:              "Website scrape started",
  SCRAPE_SUCCESS:              "Website scraped successfully",
  SCRAPE_EMPTY:                "Website returned no content",
  SCRAPE_FAILED:               "Website scrape failed",
  NO_DOMAIN:                   "No website address found",
  NO_EMAILED_LEADS:            "No lead here has a usable email — scrape skipped",
  LLM_EXTRACTION_STARTED:      "Extracting company info...",
  LLM_EXTRACTION_SUCCESS:      "Company info extracted",
  LLM_EXTRACTION_PARTIAL:      "Partial info extracted",
  LLM_EXTRACTION_FAILED:       "Extraction failed",
  ENRICHMENT_COMPLETE:         "Enrichment complete",
  ENRICHMENT_FAILED:           "Enrichment failed",
  ENRICHMENT_RETRY_QUEUED:     "Temporary failure — retrying automatically",
  ENRICHMENT_FAILED_PERMANENT: "Enrichment permanently failed",
  BATCH_COMPLETE:              "All orgs processed",
};

const SOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  firecrawl: Globe2,
  claude:    Bot,
  system:    Settings,
  apollo:    Zap,
};

// ── Sub-components ────────────────────────────────────────────────────────────

// Notion/ClickUp-style inline editing: the value itself IS the control.
// Double-click swaps the static text for a bare input in place; Enter or
// blur commits, Escape reverts — no separate "edit mode" or Save button.
function InlineField({
  value, placeholder, onCommit, type = "text", className, variant = "block",
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<void>;
  type?: string;
  className?: string;
  variant?: "block" | "inline";
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft  ] = useState(value);
  const [saving,  setSaving ] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "").trim()) return;
    setSaving(true);
    try {
      await onCommit(next);
    } catch { /* toasted by caller; value stays unchanged so the text reverts */ }
    finally { setSaving(false); }
  }

  if (editing) {
    return (
      /* eslint-disable-next-line no-restricted-syntax -- inline edit-in-place: width tracks the text via size=, which the shared Input does not do */
      <input
        ref={inputRef}
        type={type}
        value={draft}
        placeholder={placeholder}
        size={variant === "inline" ? Math.max(draft.length, 3) + 1 : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={cn(
          "bg-transparent outline-none border-b border-primary/70 focus:border-primary px-0.5 -mx-0.5",
          variant === "block" ? "block w-full" : "inline-block",
          className,
        )}
      />
    );
  }

  return (
    <span
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
      className={cn(
        "rounded px-1 -mx-1 cursor-text hover:bg-hover transition-colors",
        variant === "block" ? "block truncate" : "inline-block",
        !value && "text-muted-foreground",
        saving && "opacity-60",
        className,
      )}
    >
      {saving ? "Saving…" : (value || placeholder || "\u00A0")}
    </span>
  );
}

// Same inline-edit pattern as InlineField, but for longer free-text (company
// description, sells-to) — a growing textarea instead of a single-line input,
// and Enter inserts a newline instead of committing (blur / Escape only).
function InlineTextArea({
  value, placeholder, onCommit, className,
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft  ] = useState(value);
  const [saving,  setSaving ] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.select();
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  function autoGrow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  }

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "").trim()) return;
    setSaving(true);
    try {
      await onCommit(next);
    } catch { /* toasted by caller; value stays unchanged so the text reverts */ }
    finally { setSaving(false); }
  }

  if (editing) {
    return (
      /* eslint-disable-next-line no-restricted-syntax -- inline edit-in-place: auto-grows to its content, which the shared Textarea does not do */
      <textarea
        ref={textareaRef}
        value={draft}
        placeholder={placeholder}
        rows={3}
        onChange={autoGrow}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={cn(
          "w-full resize-none bg-transparent outline-none leading-relaxed",
          "border border-primary/60 focus:border-primary rounded-md px-2 py-1.5 -mx-2 -my-1.5",
          className,
        )}
      />
    );
  }

  return (
    <p
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
      className={cn(
        "rounded-md px-2 py-1.5 -mx-2 -my-1.5 cursor-text hover:bg-hover transition-colors leading-relaxed",
        className,
        // Last, so a caller's own text colour cannot override it: an empty field shows its
        // placeholder in gray, a filled one shows the real text in the normal colour, bolder.
        value ? "text-foreground font-medium" : "text-muted-foreground font-normal",
        saving && "opacity-60",
      )}
    >
      {saving ? "Saving…" : (value || placeholder || "\u00A0")}
    </p>
  );
}

// Campaign pill list — one pill per campaign with a colored status dot;
// collapses to 3 rows with a "+N more" toggle so 5–6 campaigns don't blow
// up the layout.
const CRM_STATUS_DOTS: Record<string, string> = {
  draft:      "bg-zinc-400",
  pending:    "bg-amber-500",
  generating: "bg-amber-500",
  approved:   "bg-blue-500",
  sent:       "bg-sky-500",
  replied:    "bg-green-500",
  failed:     "bg-red-500",
};

function CampaignPills({ campaigns, onOpen }: {
  campaigns: { id: string; name: string; crm_status: string; added_at?: string | null }[];
  onOpen: (campaignId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? campaigns : campaigns.slice(0, 3);
  const hidden = campaigns.length - 3;
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onOpen(c.id)}
          title={`Open campaign "${c.name}"`}
          className="group flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-card py-1.5 pl-2.5 pr-2 text-left transition-colors hover:bg-hover"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1 min-w-0">
              <span className="truncate text-[13px] font-medium transition-colors group-hover:text-primary">{c.name}</span>
              <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </span>
            {c.added_at && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Added {formatDate(c.added_at)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span className={cn("size-1.5 rounded-full", CRM_STATUS_DOTS[c.crm_status] ?? "bg-muted-foreground/50")} />
            <span className="text-xs capitalize text-muted-foreground">
              {c.crm_status}
            </span>
          </span>
        </button>
      ))}
      {campaigns.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Compact horizontal pipeline — replaces the tall vertical stepper so the
// whole modal fits on screen without scrolling.
const H_STAGES: LeadStatus[] = ["New", "Enriched"];

function HorizontalStepper({ currentStatus }: { currentStatus: LeadStatus }) {
  const mapped: LeadStatus =
    currentStatus === "Input Required" || currentStatus === "New" || currentStatus === "Enriching" ? "New" : "Enriched";
  const current = H_STAGES.indexOf(mapped);
  return (
    <div className="flex items-center gap-2 w-full">
      {H_STAGES.map((stage, i) => {
        const done = i <= current;
        const active = i === current;
        return (
          <Fragment key={stage}>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className={cn(
                "size-4 rounded-full border-[1.5px] flex items-center justify-center shrink-0",
                done ? "bg-primary border-primary" : "border-border",
              )}>
                {done
                  ? <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />
                  : <span className="text-[9px] font-semibold text-muted-foreground">{i + 1}</span>}
              </div>
              <span className={cn(
                "text-xs font-medium",
                active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/40",
              )}>
                {stage}
              </span>
            </div>
            {i < H_STAGES.length - 1 && (
              <div className={cn("h-px flex-1 min-w-6", done && !active ? "bg-primary" : "bg-border")} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function EnrichStageBadge({ stage, hasData }: { stage: EnrichmentStage | null; hasData?: boolean }) {
  if (!stage) return null;
  const doneLabel = hasData ? "Enriched" : "Done (no data)";
  const doneCls   = hasData
    ? "bg-green-100 text-green-800 border-green-200/70 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/25"
    : "bg-yellow-100 text-yellow-800 border-yellow-200/70 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/25";
  const configs: Record<EnrichmentStage, { label: string; cls: string }> = {
    queued:   { label: "In queue",          cls: "bg-secondary text-muted-foreground border-border" },
    scraping: { label: "Enriching...",      cls: "bg-yellow-100 text-yellow-800 border-yellow-200/70 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/25" },
    done:     { label: doneLabel,           cls: doneCls },
    failed:   { label: "Enrichment failed", cls: "bg-red-100 text-red-800 border-red-200/70 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25" },
  };
  const c = configs[stage];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-[3px] text-[11px] font-medium leading-none border", c.cls)}>
      {stage === "done"     && <CheckCircle2 className="size-3" />}
      {stage === "failed"   && <AlertCircle  className="size-3" />}
      {stage === "queued"   && <Clock        className="size-3" />}
      {stage === "scraping" && <Loader2      className="size-3 animate-spin" />}
      {c.label}
    </span>
  );
}

function TimelineItem({ log, isLast }: { log: EnrichLog; isLast: boolean }) {
  const Icon = SOURCE_ICONS[log.source] ?? Settings;
  const label = EVENT_LABELS[log.event] ?? log.event;
  const isError = !!log.error;
  const time = new Date(log.created_at).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="flex gap-2.5 text-xs">
      <div className="flex flex-col items-center shrink-0">
        <div className={cn(
          "size-5 rounded-full flex items-center justify-center border shrink-0",
          isError
            ? "bg-red-50 border-red-200 text-red-600 dark:bg-red-500/10 dark:border-red-500/25 dark:text-red-400"
            : "bg-secondary border-border text-muted-foreground",
        )}>
          <Icon className="size-2.5" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border/60 mt-1 min-h-[12px]" />}
      </div>
      <div className={cn("min-w-0", !isLast && "pb-3")}>
        <p className={cn("font-medium leading-snug", isError ? "text-red-600 dark:text-red-400" : "text-foreground")}>
          {label}
        </p>
        <div className="flex items-center gap-2 mt-0.5 text-muted-foreground text-[11px] tabular-nums">
          <span>{time}</span>
          {log.duration_ms != null && <span>· {log.duration_ms}ms</span>}
        </div>
        {log.error && (
          <p className="mt-1 text-red-600 dark:text-red-400 text-[11px] break-all leading-relaxed">
            {log.error}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Clean lead activity item (Problem 8) ───────────────────────────────────────

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  created: Zap,
  enriched: CheckCircle2,
  enrichment_failed: AlertCircle,
  assigned: UserCog,
  reassigned: UserCog,
  unassigned: UserCog,
  added_to_campaign: Megaphone,
  removed_from_campaign: Megaphone,
  draft_created: Pencil,
  draft_failed: AlertCircle,
  draft_approved: CheckCircle2,
  draft_rejected: XCircle,
  draft_edited: Pencil,
  draft_reopened: RotateCcw,
  draft_sent: Send,
  email_delivered: MailCheck,
  email_opened: MailOpen,
  email_bounced: AlertCircle,
  reply_received: Reply,
  interest_changed: Sparkles,
  unsubscribed: BellOff,
  status_changed: RefreshCw,
};

// Events that represent something going wrong — tinted amber in the timeline
// rather than silently reading like normal progress.
const BAD_ACTIVITY_EVENTS = new Set(["enrichment_failed", "draft_failed", "email_bounced", "unsubscribed"]);

// Activity is an audit trail, so entries carry a calendar-anchored timestamp
// ("yesterday at 05:42 PM") rather than an elapsed-only label ("1d ago") —
// elapsed labels lose the time of day, which is what you need when
// reconstructing the order things actually happened in.
function activityTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;

  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true,
  });

  // Compare calendar days in local time — a diff in hours would call 11pm
  // yesterday "today" when read at 1am.
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);

  if (dayDelta === 0) return `today at ${time}`;
  if (dayDelta === 1) return `yesterday at ${time}`;

  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} at ${time}`;
}

// Full timestamp for the hover tooltip, so an exact value is always reachable.
function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function ActivityItem({ event, isLast, onCampaignClick }: {
  event: LeadActivityEvent;
  isLast: boolean;
  onCampaignClick?: (campaignId: string) => void;
}) {
  const Icon = ACTIVITY_ICONS[event.event] ?? Clock;
  const isBad = BAD_ACTIVITY_EVENTS.has(event.event);

  // If the event references a campaign, render its name as a link — either
  // inline (when the detail text quotes the name) or appended after the text.
  const detailText = event.detail ?? event.event;
  const canLink = !!(event.campaign_id && event.campaign_name && onCampaignClick);
  const quoted = canLink ? `"${event.campaign_name}"` : "";
  const inline = canLink && detailText.includes(quoted);
  const [before, after] = inline ? detailText.split(quoted) : [detailText, ""];

  const campaignLink = canLink && (
    <button
      type="button"
      onClick={() => onCampaignClick!(event.campaign_id!)}
      className="text-primary hover:underline font-medium"
      title={`Open campaign "${event.campaign_name}"`}
    >
      {inline ? quoted : event.campaign_name}
    </button>
  );

  return (
    <div className="flex gap-3 text-[13px]">
      <div className="flex flex-col items-center shrink-0">
        <div className={cn(
          "size-6 rounded-full flex items-center justify-center border shrink-0",
          isBad ? "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/10 dark:border-amber-500/25 dark:text-amber-300" : "bg-card border-border text-muted-foreground",
        )}>
          <Icon className="size-3" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-1 min-h-[12px]" />}
      </div>
      <div className={cn("min-w-0 pt-0.5", !isLast && "pb-4")}>
        <p className="font-medium leading-snug text-foreground">
          {inline ? <>{before}{campaignLink}{after}</> : detailText}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
          <span title={fullTimestamp(event.created_at)}>{activityTimestamp(event.created_at)}</span>
          {event.actor_name && <span>· by {event.actor_name}</span>}
          {canLink && !inline && <span>· in {campaignLink}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton loading state ────────────────────────────────────────────────────

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-secondary", className)} />;
}

function LeadDrawerSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 px-6 pb-3 pt-5">
          <Bone className="size-10 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Bone className="h-4 w-44" />
            <Bone className="h-3 w-28" />
          </div>
        </div>
        <div className="flex gap-5 border-b border-border px-6 pb-3 pt-1">
          {Array.from({ length: 3 }).map((_, i) => <Bone key={i} className="h-3 w-16" />)}
        </div>
        <div className="space-y-3 px-6 py-5">
          <Bone className="h-4 w-36" />
          <div className="h-28 rounded-lg border border-border bg-card" />
        </div>
      </div>
      <div className="hidden w-[340px] shrink-0 space-y-3 border-l border-border bg-card p-4 lg:block">
        <Bone className="h-3.5 w-28" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Bone className="h-3 w-20" />
            <Bone className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────

const enrichStatusKey = (orgId: string) => `/api/enrich/status?org_id=${orgId}`;

export function LeadDrawer({ lead, onClose, onLeadUpdated, onOrgClick }: {
  lead: Lead | null;
  onClose: () => void;
  onLeadUpdated?: (updated: Lead) => void;
  onOrgClick?: (orgId: string) => void;
}) {
  const { role, session } = useApp();
  const router = useRouter();
  const [freshLead,   setFreshLead  ] = useState<Lead | null>(null);
  const [loadingLead, setLoadingLead] = useState(false);
  const [enrichData,  setEnrichData ] = useState<EnrichStatus | null>(null);
  const [activity,    setActivity   ] = useState<LeadActivityEvent[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  // Record tabs: Overview (company profile), Activity, Discussion.
  const [railMode,    setRailMode   ] = useState<"overview" | "activity" | "discussion">("overview");
  const [comments,    setComments   ] = useState<LeadComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [loadingComments, setLoadingComments] = useState(false);
  const [sendingComment,  setSendingComment ] = useState(false);
  const [retrying,    setRetrying   ] = useState(false);
  // Users list is shared/cached (the Leads page loads the same one).
  const usersQuery = useCached<Profile[]>(role === "manager" ? cacheKeys.users : null, cachedFetchers.users);
  const employees = (usersQuery.data ?? []).filter((u) => u.role === "employee" && u.is_active);
  const [reassigning, setReassigning] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement | null>(null);

  // Tracks the lead id the drawer is currently showing so in-flight fetches
  // can't update state / call onLeadUpdated after the user has closed it.
  const activeLeadIdRef = useRef<string | null>(null);
  activeLeadIdRef.current = lead?.id ?? null;

  const display = freshLead ?? lead;

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  const fetchFresh = useCallback(async (l: Lead) => {
    setLoadingLead(true);
    try {
      const tok = await getToken();
      if (!tok) return;
      // Through the cache: joins a hover prefetch already in flight.
      const updated = await queryCache.fetch(cacheKeys.lead(l.id), () => fetchLead(tok, l.id));
      if (activeLeadIdRef.current !== l.id) return;
      setFreshLead(updated);
      onLeadUpdated?.(updated);
    } catch { /* keep stale */ }
    finally {
      if (activeLeadIdRef.current === l.id) setLoadingLead(false);
    }
  }, [onLeadUpdated]);

  const fetchEnrichStatus = useCallback(async (orgId: string) => {
    try {
      const tok = await getToken();
      if (!tok) return;
      const res = await fetch(`/api/enrich/status?org_id=${orgId}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const json = await res.json() as { success: boolean; data?: EnrichStatus };
      if (json.success && json.data) queryCache.set(enrichStatusKey(orgId), json.data);
      if (activeLeadIdRef.current == null) return;
      if (json.success && json.data) setEnrichData(json.data);
    } catch { /* non-fatal */ }
  }, []);

  const fetchActivity = useCallback(async (leadId: string) => {
    // Spinner only when there is nothing cached to show meanwhile.
    setLoadingActivity(queryCache.getData(cacheKeys.leadActivity(leadId)) === undefined);
    try {
      const tok = await getToken();
      if (!tok) return;
      const events = await queryCache.fetch(cacheKeys.leadActivity(leadId), () => fetchLeadActivity(tok, leadId));
      if (activeLeadIdRef.current !== leadId) return;
      setActivity(events);
    } catch { /* non-fatal */ }
    finally { if (activeLeadIdRef.current === leadId) setLoadingActivity(false); }
  }, []);

  const loadComments = useCallback(async (leadId: string, quiet = false) => {
    if (!quiet) setLoadingComments(true);
    try {
      const tok = await getToken();
      if (!tok) return;
      const next = await queryCache.fetch(cacheKeys.leadComments(leadId), () => fetchLeadComments(tok, leadId));
      if (activeLeadIdRef.current !== leadId) return;
      setComments((current) => {
        if (!quiet) return next;
        const byId = new Map(current.map((comment) => [comment.id, comment]));
        for (const comment of next) byId.set(comment.id, comment);
        return [...byId.values()].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
      });
    } catch (error) {
      if (!quiet) toast.error((error as Error).message || "Could not load the discussion");
    } finally {
      if (!quiet && activeLeadIdRef.current === leadId) setLoadingComments(false);
    }
  }, []);

  async function handleSendComment() {
    if (!display || sendingComment || !commentBody.trim()) return;
    const body = commentBody.trim();
    setSendingComment(true);
    try {
      const tok = await getToken();
      const comment = await postLeadComment(tok, display.id, body);
      setComments((current) => [...current, comment]);
      setCommentBody("");
    } catch (error) {
      toast.error((error as Error).message || "Could not send the message");
    } finally {
      setSendingComment(false);
    }
  }

  async function handleToggleCommentReaction(commentId: string, emoji: string) {
    if (!display) return;
    try {
      const tok = await getToken();
      const reactions = await toggleLeadCommentReaction(tok, display.id, commentId, emoji);
      setComments((current) =>
        current.map((comment) =>
          comment.id === commentId ? { ...comment, reactions } : comment,
        ),
      );
    } catch (error) {
      toast.error((error as Error).message || "Could not update reaction");
      throw error;
    }
  }

  // Notion/ClickUp-style field save: each InlineField commits its own patch
  // the moment it loses focus, no separate "edit mode" or Save button.
  async function saveField(patch: Record<string, string>, label: string) {
    if (!display) return;
    try {
      const tok = await getToken();
      const updated = await patchLead(tok, display.id, patch);
      queryCache.set(cacheKeys.lead(display.id), updated);
      setFreshLead(updated);
      onLeadUpdated?.(updated);
    } catch (e) {
      toast.error((e as Error).message || `Couldn't update ${label}`);
      throw e;
    }
  }

  // Company description / sells-to belong to the organization, not the lead —
  // they're shared across every lead under that org (review §3.4), so the
  // edit is written to the org record and the enrichment panel re-synced from
  // there rather than patched onto this one lead.
  async function saveOrgField(patch: Record<string, string>, label: string) {
    if (!display?.orgId) return;
    try {
      const tok = await getToken();
      await patchOrg(tok, display.orgId, patch);
      await fetchEnrichStatus(display.orgId);
    } catch (e) {
      toast.error((e as Error).message || `Couldn't update ${label}`);
      throw e;
    }
  }

  // Single-lead reassignment (manager-only) — previously the only way to move
  // one lead was bulk-assign or a campaign-assign side effect (review §3.2).
  async function handleReassign(nextAssignee: string | null) {
    if (!display || reassigning) return;
    setReassigning(true);
    try {
      const tok = await getToken();
      const updated = await patchLead(tok, display.id, { assigned_to: nextAssignee });
      queryCache.set(cacheKeys.lead(display.id), updated);
      setFreshLead(updated);
      onLeadUpdated?.(updated);
      toast.success(nextAssignee ? "Lead reassigned" : "Lead returned to the pool");
      if (updated.manual_target_offline) {
        toast.warning("Heads up: that employee is currently marked offline (away).");
      }
    } catch (e) {
      toast.error((e as Error).message || "Failed to reassign lead");
    } finally {
      setReassigning(false);
    }
  }

  // Layout effect so the cached activity/comments land before the drawer's
  // first paint instead of one frame later.
  useLayoutEffect(() => {
    if (!lead) {
      setFreshLead(null);
      setEnrichData(null);
      setActivity([]);
      setComments([]);
      setCommentBody("");
      setRailMode("overview");
      return;
    }
    // Whatever is cached for this lead (a previous open, or a row hover
    // prefetch) shows at once; the fetches below refresh it.
    setFreshLead(queryCache.getData<Lead>(cacheKeys.lead(lead.id)) ?? null);
    setEnrichData(lead.orgId ? queryCache.getData<EnrichStatus>(enrichStatusKey(lead.orgId)) ?? null : null);
    setActivity(queryCache.getData<LeadActivityEvent[]>(cacheKeys.leadActivity(lead.id)) ?? []);
    setComments(queryCache.getData<LeadComment[]>(cacheKeys.leadComments(lead.id)) ?? []);
    setCommentBody("");
    setRailMode("overview");
    void fetchFresh(lead);
    void fetchActivity(lead.id);
    // Quiet prefetch so the Discussion tab / chat icon can show a message
    // count without the user having to open the tab first.
    void loadComments(lead.id, true);
    if (lead.orgId) void fetchEnrichStatus(lead.orgId);
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!lead || railMode !== "discussion") return;
    void loadComments(lead.id);
    const interval = window.setInterval(() => void loadComments(lead.id, true), 10000);
    return () => window.clearInterval(interval);
  }, [lead?.id, railMode, loadComments]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (railMode !== "discussion") return;
    commentsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [comments, railMode]);

  useEffect(() => {
    if (!lead) return;
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lead, onClose]);

  async function handleRetry() {
    if (!display?.orgId) return;
    setRetrying(true);
    try {
      const tok = await getToken();
      await rescrapeOrg(tok, display.orgId);
      setTimeout(async () => {
        if (display.orgId) await fetchEnrichStatus(display.orgId);
        if (lead) await fetchFresh(lead);
        // A retry that still fails is almost always billing, not a dead
        // website — surface the real upstream cause instead of letting the
        // generic "couldn't read website" copy mislead the manager again.
        fetchServiceHealth(tok)
          .then((issues) => {
            const openrouter = issues.find((i) => i.service === "OpenRouter");
            const firecrawl = issues.find((i) => i.service === "Firecrawl");
            if (openrouter) toast.error(openrouter.message);
            if (firecrawl) toast.error(firecrawl.message);
          })
          .catch(() => {});
      }, 800);
    } catch { /* non-fatal */ }
    finally { setRetrying(false); }
  }

  const open = lead !== null;
  const currentStage = enrichData?.enrichment_stage ?? display?.enrichmentStage ?? null;
  const attempts = enrichData?.enrichment_attempts ?? 0;
  const enrichHasData = !!((enrichData?.company_description || display?.companyDescription));

  if (!open) return null;

  const fullName = display ? `${display.firstName} ${display.lastName}`.trim() : "";

  // The attribute list: the Details rail on wide screens, the top of the
  // Overview tab below `lg` (where RecordLayout hides the rail).
  const details = display && (
    <>
      <DetailSection title="Record details">
        <DetailRow icon={<Zap />} label="Status">
          <span className="flex items-center gap-1.5">
            <StatusBadge status={display.status} />
            {display.score !== "—" && <ScoreBadge score={display.score} />}
          </span>
        </DetailRow>
        <DetailRow icon={<Users />} label="Pipeline">
          <HorizontalStepper currentStatus={display.status} />
        </DetailRow>
        {role === "manager" && (
          <DetailRow icon={<UserCog />} label="Owner">
            <Select
              value={display.assignedTo ?? "unassigned"}
              onValueChange={(v) => void handleReassign(v === "unassigned" ? null : v)}
              disabled={reassigning}
            >
              <SelectTrigger className="-ml-1.5 h-7 w-auto max-w-full gap-1.5 border-0 bg-transparent px-1.5 text-[13px] shadow-none hover:bg-hover">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned (pool)</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.full_name || e.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DetailRow>
        )}
        <DetailRow icon={<Mail />} label="Email">
          <InlineField
            value={display.email}
            placeholder="Not yet enriched"
            type="email"
            onCommit={(v) => v ? saveField({ email: v }, "email") : Promise.resolve()}
          />
        </DetailRow>
        <DetailRow icon={<Phone />} label="Phone">
          <InlineField
            value={display.phone}
            placeholder="Add phone"
            type="tel"
            className="tabular-nums"
            onCommit={(v) => saveField({ phone: v }, "phone")}
          />
        </DetailRow>
        <DetailRow icon={<Pencil />} label="Job title">
          <InlineField
            value={display.jobTitle}
            placeholder="Add job title"
            onCommit={(v) => saveField({ title: v }, "job title")}
          />
        </DetailRow>
        <DetailRow icon={<MapPin />} label="Country">
          <InlineField
            value={display.country}
            placeholder="Add country"
            onCommit={(v) => saveField({ country: v }, "country")}
          />
        </DetailRow>
        <DetailRow icon={<Globe2 />} label="Source">
          <span className="inline-flex items-center rounded-[5px] border border-border bg-secondary px-1.5 py-[3px] text-xs leading-none text-muted-foreground">
            {display.source}
          </span>
        </DetailRow>
        <DetailRow icon={<Clock />} label="Created">
          <span className="tabular-nums">{formatDate(display.createdAt)}</span>
        </DetailRow>
      </DetailSection>

      <DetailSection title="Organization">
        {display.company ? (
          <div className="min-w-0 py-1 text-[13px]">
            <button
              type="button"
              onClick={() => display.orgId && onOrgClick?.(display.orgId)}
              disabled={!display.orgId || !onOrgClick}
              className="group flex max-w-full items-center gap-2 rounded-md py-0.5 font-medium transition-colors hover:text-primary disabled:hover:text-foreground"
            >
              <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-border bg-field text-muted-foreground">
                <Building2 className="size-3" />
              </span>
              <span className="truncate">{display.company}</span>
              {display.orgId && onOrgClick && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
            {display.domain && (
              <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-7">
                <a href={/^https?:\/\//i.test(display.domain) ? display.domain : `https://${display.domain}`} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-primary hover:underline">{display.domain}</a>
                {display.domainSource === "email_inferred" && (
                  <span className="shrink-0 rounded-[4px] border border-amber-200 bg-amber-50 px-1 py-0.5 text-[11px] leading-none text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">Inferred</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="py-1 text-[13px] text-muted-foreground">No organization</p>
        )}
      </DetailSection>

      <DetailSection title="Campaigns">
        {display.campaigns && display.campaigns.length > 0 ? (
          <div className="py-1">
            <CampaignPills
              campaigns={display.campaigns}
              onOpen={(campaignId) => {
                onClose();
                router.push(`/campaigns/${campaignId}`);
              }}
            />
          </div>
        ) : (
          <p className="py-1 text-[13px] text-muted-foreground">Not in any campaign</p>
        )}
      </DetailSection>
    </>
  );

  const tabBody = !display ? null : railMode === "overview" ? (
    <div className="space-y-6">
      {/* Below lg the Details rail is hidden — show the same attributes here. */}
      <div className="overflow-hidden rounded-lg border border-border bg-card lg:hidden">{details}</div>

      {/* ── Company profile (org-level enrichment) ── */}
      <section>
        <div className="flex items-center justify-between gap-3 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">Company profile</h3>
            <EnrichStageBadge stage={currentStage} hasData={enrichHasData} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Rescraping spends credits — manager-only. Employees work
                their leads as given; enrichment is the manager's job
                (planning.md D8 / Q6). */}
            {/* No attempts<3 gate: the 3-attempt cap is for the
                automatic-retry loop only. A manually clicked retry
                always gets a fresh budget server-side (see rescrape
                route) — otherwise a permanently-failed org could
                never be retried even after topping up credits. */}
            {role === "manager" && (currentStage === "failed" || currentStage === "queued" || currentStage === null || (currentStage === "done" && !enrichHasData)) && (
              <Button
                size="sm" variant="outline"
                onClick={handleRetry}
                disabled={retrying}
                title="Reads the company website again: about 1 Firecrawl credit, plus a few cents of AI for the company profile"
              >
                <RotateCcw className={cn("size-3.5", retrying && "animate-spin")} />
                {currentStage === "failed" || (currentStage === "done" && !enrichHasData) ? "Retry" : "Enrich"}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (lead) void fetchFresh(lead);
                if (display.orgId) void fetchEnrichStatus(display.orgId);
              }}
              disabled={loadingLead}
              className="text-muted-foreground"
            >
              <RefreshCw className={cn("size-3.5", loadingLead && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {!!display.orgId && (
            <div className="grid gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">What they do</p>
                <InlineTextArea
                  value={enrichData?.company_description ?? display.companyDescription ?? ""}
                  placeholder="Add a description of what this company does"
                  className="text-sm text-foreground"
                  onCommit={(v) => saveOrgField({ company_description: v }, "company description")}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">Who they sell to</p>
                <InlineTextArea
                  value={enrichData?.sells_to ?? display.sellsTo ?? ""}
                  placeholder="Add who this company sells to"
                  className="text-sm text-foreground"
                  onCommit={(v) => saveOrgField({ sells_to: v }, "who they sell to")}
                />
              </div>
            </div>
          )}
          {/* Friendly, non-technical status — the raw upstream error
              (HTTP 402 dumps etc.) stays server-side in enrichment_logs.
              Retry additionally toasts the real cause (see handleRetry)
              when it's a billing issue, so this copy stays deliberately
              vague rather than blaming the website. */}
          {currentStage === "failed" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Couldn&apos;t build a company profile.
                This lead can still be emailed using the generic template.
                {attempts >= 3 ? " Automatic retries exhausted — use Refresh to try again." : ""}
              </span>
            </div>
          )}
          {(currentStage === "queued" || currentStage === "scraping") && (
            <div className="flex items-center justify-center gap-2 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {currentStage === "scraping" ? "Reading company website..." : "Waiting to start..."}
            </div>
          )}
          {!display.orgId && (
            <p className="py-2 text-center text-[13px] text-muted-foreground">
              No organization linked to this lead.
            </p>
          )}

          {/* Org-level enrichment fans out to every lead under that org
              regardless of owner (review §3.4) — quiet footnote so a
              change from someone else's trigger isn't a surprise. */}
          {!!display.orgShared && display.orgShared.otherOwnerCount > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              This company profile is shared with {display.orgShared.otherLeadCount} other lead{display.orgShared.otherLeadCount === 1 ? "" : "s"} across {display.orgShared.otherOwnerCount} other owner{display.orgShared.otherOwnerCount === 1 ? "" : "s"} — enrichment updates here apply to all of them, however triggered.
            </p>
          )}
        </div>
      </section>
    </div>
  ) : railMode === "activity" ? (
    <div className="max-w-2xl">
      {loadingActivity ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-2.5">
              <Bone className="size-6 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Bone className="h-3.5 w-3/4" />
                <Bone className="h-2.5 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : activity.length === 0 ? (
        <EmptyState boxed={false} icon={Clock} title="No activity yet" message="Enrichment, campaign and email events for this lead show up here." />
      ) : (
        <div>
          {activity.map((ev, i) => (
            <ActivityItem
              key={i}
              event={ev}
              isLast={i === activity.length - 1}
              onCampaignClick={(campaignId) => {
                onClose();
                router.push(`/campaigns/${campaignId}`);
              }}
            />
          ))}
        </div>
      )}
    </div>
  ) : (
    <div className="flex min-h-full max-w-2xl flex-col">
      <div className="flex-1">
        {loadingComments ? (
          <div className="space-y-4 pt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={cn("flex gap-2.5", i % 2 === 0 ? "" : "flex-row-reverse")}>
                <Bone className="size-7 shrink-0 rounded-full" />
                <div className="max-w-[70%] space-y-1.5">
                  <Bone className="h-3 w-16" />
                  <Bone className="h-12 w-44 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : comments.length === 0 ? (
          <EmptyState
            boxed={false}
            icon={MessageSquare}
            title="Start the discussion"
            message="Notes here are visible to managers and employees who can access this lead."
          />
        ) : (
          <div className="space-y-2.5">
            {comments.map((comment, index) => {
              const own = comment.author_id === session?.user.id;
              const showDate = startsNewChatDay(
                comment.created_at,
                comments[index - 1]?.created_at,
              );
              return (
                <div key={comment.id} className="space-y-3">
                  {showDate && (
                    <div className="flex items-center justify-center py-1">
                      <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium leading-none text-muted-foreground">
                        {formatChatDate(comment.created_at)}
                      </span>
                    </div>
                  )}
                  <DiscussionComment
                    comment={comment}
                    isOwn={own}
                    currentUserId={session?.user.id ?? ""}
                    compact
                    onToggleReaction={(emoji) => handleToggleCommentReaction(comment.id, emoji)}
                  />
                </div>
              );
            })}
            <div ref={commentsEndRef} />
          </div>
        )}
      </div>
      {/* Composer stays pinned to the bottom of the tab while the thread scrolls. */}
      <div className="sticky bottom-0 -mb-5 bg-background pb-5 pt-3">
        <div className="rounded-lg border border-border bg-field shadow-xs">
          <Textarea
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSendComment();
              }
            }}
            maxLength={2000}
            rows={3}
            placeholder="Write a message to the team…"
            className="min-h-[72px] resize-none border-0 bg-transparent px-3 pt-2.5 text-[13px] shadow-none"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="text-xs text-muted-foreground">
              Ctrl/⌘ + Enter to send
            </span>
            <Button
              type="button"
              size="icon-sm"
              onClick={() => void handleSendComment()}
              disabled={!commentBody.trim() || sendingComment}
              aria-label="Send message"
              title="Send message"
            >
              {sendingComment
                ? <Loader2 className="size-3.5 animate-spin" />
                : <ArrowUp className="size-3.5" strokeWidth={2.5} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/25 dark:bg-black/60" onClick={onClose} />

      {/* Record sheet from the right */}
      <div
        role="dialog"
        aria-label={fullName || "Lead"}
        className="fixed right-0 top-0 z-50 flex h-full w-[min(1100px,92vw)] flex-col border-l border-border bg-background shadow-xl"
      >
        <PageHeader
          crumbs={[
            { icon: <User />, label: "Lead" },
            { label: fullName || (loadingLead ? "Loading…" : "Lead") },
          ]}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setRailMode("discussion")}
                className={cn(
                  "relative text-muted-foreground",
                  railMode === "discussion" && "bg-hover text-foreground",
                )}
                title="Open lead discussion"
                aria-label="Open lead discussion"
              >
                <MessageSquare className="size-3.5" />
                {comments.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary px-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary-foreground">
                    {comments.length > 99 ? "99+" : comments.length}
                  </span>
                )}
              </Button>
              <Button
                type="button" variant="ghost" size="icon-sm" onClick={onClose}
                className="text-muted-foreground"
                aria-label="Close lead"
              >
                <X className="size-4" />
              </Button>
            </>
          }
        />

        {!display ? (
          <LeadDrawerSkeleton />
        ) : (
          <RecordLayout
            header={
              <RecordHeader
                avatar={<Avatar name={fullName} size="md" />}
                title={
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <InlineField
                      value={display.firstName}
                      placeholder="First name"
                      variant="inline"
                      className="text-lg font-semibold"
                      onCommit={(v) => saveField({ first_name: v }, "first name")}
                    />
                    <InlineField
                      value={display.lastName}
                      placeholder="Last name"
                      variant="inline"
                      className="text-lg font-semibold"
                      onCommit={(v) => saveField({ last_name: v }, "last name")}
                    />
                  </span>
                }
                subtitle={[display.jobTitle, display.company].filter(Boolean).join(" · ") || undefined}
                badges={
                  <>
                    <StatusBadge status={display.status} />
                    {display.score !== "—" && <ScoreBadge score={display.score} />}
                  </>
                }
              />
            }
            tabs={
              <SegmentedTabs
                variant="underline"
                value={railMode}
                onValueChange={setRailMode}
                options={[
                  { value: "overview",   label: "Overview",   icon: LayoutGrid },
                  { value: "activity",   label: "Activity",   icon: Clock },
                  { value: "discussion", label: "Discussion", icon: MessageSquare, count: comments.length },
                ]}
              />
            }
            details={details}
          >
            {tabBody}
          </RecordLayout>
        )}
      </div>
    </>
  );
}
