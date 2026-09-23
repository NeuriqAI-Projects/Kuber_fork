"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Pencil, Check, X, Gauge, Coins, CalendarDays, TrendingDown, Zap } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart } from "@/components/app/usage-bar-chart";
import {
  UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton, ProgressRowSkeleton,
} from "@/components/app/usage-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchApolloUsage, setApolloCreditAllowance,
  type ApolloUsageData, type ApolloEndpointUsage, type ApolloCreditWindow, type ApolloCreditUsageStats,
} from "@/lib/api-client";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function formatDateTimeTz(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

// Labelled straight from Apollo's own field names — `lead_credit` is the
// pool Apollo's dashboard calls "Team credit usage" (spent on exports +
// email/phone reveals); everything else is a separate per-feature allowance.
const CREDIT_POOL_LABELS: Record<keyof ApolloCreditUsageStats, string> = {
  lead_credit: "Team credits (exports + reveals)",
  direct_dial_credit: "Direct dial credits",
  export_credit: "Export credits",
  conversation_credit: "Conversation minutes",
  ai_credit: "AI-generated words",
  power_up_credit: "Power-up credits",
  inbound_website_visitor_credit: "Inbound website visitor credits",
  dialer: "Dialer minutes",
  web_search_record_credit: "Web search records",
  contact_website_visitor_credit: "Contact website visitor credits",
};

function CreditPoolRow({ label, w }: { label: string; w: ApolloCreditWindow }) {
  if (w.limit === 0 && w.consumed === 0) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/60">not on plan</span>
      </div>
    );
  }
  const pct = w.limit > 0 ? Math.min(100, Math.round((w.consumed / w.limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">
          {w.consumed.toLocaleString()} / {w.limit.toLocaleString()}
          <span className="text-muted-foreground/70"> · {w.left_over.toLocaleString()} left</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-amber-400" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Editable "monthly credit budget" — the only way "remaining" can be shown
 *  at all, since Apollo's API has no balance endpoint (see the route's own
 *  comment). Inline edit rather than a modal; this is a single number. */
function AllowanceEditor({
  allowance, onSave,
}: {
  allowance: number | null;
  onSave: (value: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(allowance != null ? String(allowance) : "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(allowance != null ? String(allowance) : ""); }, [allowance]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Pencil className="size-3" />
        {allowance != null ? `Budget: ${allowance.toLocaleString()}/mo` : "Set a monthly budget"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 10000"
        className="h-7 w-28 text-xs"
        autoFocus
      />
      <Button
        type="button" size="icon" variant="ghost" className="size-7"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            const n = value.trim() === "" ? null : Number(value);
            await onSave(Number.isFinite(n as number) || n === null ? n : null);
            setEditing(false);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Check className="size-3.5" />
      </Button>
      <Button type="button" size="icon" variant="ghost" className="size-7" onClick={() => setEditing(false)}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

type UsageWindow = { limit: number; consumed: number; left_over: number };

function RateLimitRow({ label, endpoint }: { label: string; endpoint: ApolloEndpointUsage }) {
  // Apollo doesn't expose every window for every endpoint — bulk_match came
  // back with only `minute` live (no `day`/`hour` at all), so pick whichever
  // is actually present instead of assuming `day` always exists.
  const windows: [string, UsageWindow | undefined][] = [
    ["today", endpoint.day], ["this hour", endpoint.hour], ["this minute", endpoint.minute],
  ];
  const [windowLabel, w] = windows.find(([, win]) => win != null) ?? ["", undefined];
  if (!w) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/60">no data</span>
      </div>
    );
  }
  const pct = w.limit > 0 ? Math.min(100, Math.round((w.consumed / w.limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{w.consumed} / {w.limit} {windowLabel}</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-amber-400" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ApolloUsageView() {
  const { session } = useApp();
  const [data, setData] = useState<ApolloUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetchApolloUsage(session.access_token, refresh);
      setData(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => { void load(false); }, [load]);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <UsageHeaderSkeleton />
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="space-y-1.5">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-2.5 w-56" />
          </div>
          <StatTileGridSkeleton count={4} />
          <div className="pt-1 space-y-3">
            <Skeleton className="h-2.5 w-40" />
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {Array.from({ length: 10 }).map((_, i) => <ProgressRowSkeleton key={i} />)}
            </div>
          </div>
        </div>
        <StatTileGridSkeleton count={4} />
        <ChartCardSkeleton />
        <RowsCardSkeleton rows={3} />
        <RowsCardSkeleton rows={5} />
      </div>
    );
  }

  const {
    key, consumed, allowanceMonthly, remainingThisMonth, daily, rateLimits, rateLimitsError,
    creditUsage, creditCycle, creditUsageError, history,
  } = data;

  // Apollo's rate-limit payload lists every endpoint the account can call —
  // this app only ever calls bulk_match (email reveal) and mixed_people search,
  // so only those are worth showing instead of a 30-row wall of zeros.
  const relevantLimits = (rateLimits ?? []).filter(
    (r) => r.action === "bulk_match" || (r.action === "api_search" && r.resource === "mixed_people"),
  );

  const chartData = daily.map((d) => ({ date: d.date, credits: d.credits }));

  const lead = creditUsage?.lead_credit;
  const leadPctLeft = lead && lead.limit > 0 ? Math.round((lead.left_over / lead.limit) * 100) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground max-w-2xl">
            Team credit numbers below come live from Apollo&apos;s account (same figures as Apollo&apos;s own Settings &gt;
            Usage page). The activity ledger further down is this app&apos;s own record, kept in Supabase, of what it
            specifically has spent — useful if the account is shared with other tools or seats.
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)} className="gap-1.5">
            <Gauge className={cn("size-3.5", refreshing && "animate-pulse")} />
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
          <AllowanceEditor
            allowance={allowanceMonthly}
            onSave={async (v) => {
              if (!session) return;
              await setApolloCreditAllowance(session.access_token, v);
              await load(false);
            }}
          />
        </div>
      </div>

      {!key.ok && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {key.message}
        </div>
      )}

      {creditUsageError ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-500">
          Could not read live team credits ({creditUsageError}) — this endpoint requires a Master API key. Falling back to
          this app&apos;s own ledger below.
        </div>
      ) : creditUsage && creditCycle ? (
        <Card className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="eyebrow">Billing cycle</p>
              <p className="text-sm font-medium">{formatDate(creditCycle.start_date)} – {formatDate(creditCycle.end_date)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Usage renews {formatDateTimeTz(creditCycle.end_date)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile
              label="Team credits used"
              value={lead ? `${lead.consumed.toLocaleString()} / ${lead.limit.toLocaleString()}` : "—"}
              icon={Coins}
              tone={leadPctLeft != null && leadPctLeft <= 10 ? "red" : "sky"}
            />
            <StatTile
              label="Team credits left"
              value={lead ? lead.left_over.toLocaleString() : "—"}
              icon={TrendingDown}
              tone={lead && lead.left_over <= 0 ? "red" : leadPctLeft != null && leadPctLeft <= 20 ? "amber" : "neutral"}
              sub={leadPctLeft != null ? `${leadPctLeft}% remaining` : undefined}
            />
            <StatTile
              label="AI words used"
              value={creditUsage.ai_credit.consumed.toLocaleString()}
              icon={Zap}
              sub={`of ${creditUsage.ai_credit.limit.toLocaleString()}/mo`}
            />
            <StatTile
              label="Conversation minutes used"
              value={creditUsage.conversation_credit.consumed.toLocaleString()}
              icon={CalendarDays}
              sub={`of ${creditUsage.conversation_credit.limit.toLocaleString()}/mo`}
            />
          </div>

          <div className="pt-1">
            <p className="eyebrow mb-2">All credit pools (live from Apollo)</p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {(Object.keys(CREDIT_POOL_LABELS) as (keyof ApolloCreditUsageStats)[]).map((k) => (
                <CreditPoolRow key={k} label={CREDIT_POOL_LABELS[k]} w={creditUsage[k]} />
              ))}
            </div>
          </div>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">Loading live team credits…</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="This app: used today" value={consumed.today} icon={Coins} />
        <StatTile label="This app: used this week" value={consumed.week} icon={CalendarDays} />
        <StatTile label="This app: used this month" value={consumed.month} icon={CalendarDays} tone="sky" />
        <StatTile
          label="This app: remaining vs budget"
          value={remainingThisMonth != null ? remainingThisMonth : "—"}
          icon={TrendingDown}
          tone={remainingThisMonth != null && remainingThisMonth <= 0 ? "red" : "amber"}
          sub={allowanceMonthly != null ? `of ${allowanceMonthly.toLocaleString()} budget` : "no budget set"}
        />
      </div>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Credits consumed</p>
            <p className="text-xs text-muted-foreground">Last 14 days, from every email-reveal batch this app has run.</p>
          </div>
          <p className="font-mono text-sm font-semibold tabular-nums">{consumed.allTime.toLocaleString()} total (90d)</p>
        </div>
        <UsageBarChart data={chartData} bars={[{ dataKey: "credits", name: "Credits", color: "var(--primary)" }]} />
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <p className="eyebrow">API rate limits</p>
          <p className="text-xs text-muted-foreground">
            Live from Apollo&apos;s usage_stats endpoint — the closest thing to &quot;usage&quot; their API actually exposes.
          </p>
        </div>
        {rateLimitsError ? (
          <p className="text-xs text-muted-foreground">
            Could not read rate limits ({rateLimitsError}) — this endpoint requires a Master API key.
          </p>
        ) : relevantLimits.length === 0 ? (
          <p className="text-xs text-muted-foreground">No bulk_match calls recorded by Apollo yet today.</p>
        ) : (
          <div className="space-y-3">
            {relevantLimits.map((r) => (
              <RateLimitRow key={`${r.resource}-${r.action}`} label={`${r.resource} · ${r.action}`} endpoint={r} />
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <p className="eyebrow">Recent activity</p>
          <p className="text-xs text-muted-foreground">Every enrichment batch and skipped/failed attempt, most recent first.</p>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No Apollo activity recorded yet.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-3 py-2">Event</th>
                  <th className="text-right font-medium px-3 py-2">Credits</th>
                  <th className="text-right font-medium px-3 py-2">Matched</th>
                  <th className="text-right font-medium px-3 py-2">Archived</th>
                  <th className="text-left font-medium px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((h) => (
                  <tr key={h.id} className={cn(h.credits_consumed === 0 && h.event !== "CREDITS_CONSUMED" ? "text-muted-foreground" : "")}>
                    <td className="px-3 py-2 whitespace-nowrap font-mono">{formatDateTime(h.created_at)}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        "inline-flex items-center gap-1.5",
                        h.event === "CREDITS_CONSUMED" ? "text-emerald-500" : h.event === "CREDITS_EXHAUSTED" ? "text-destructive" : "text-amber-400",
                      )}>
                        <span className={cn(
                          "size-1.5 rounded-full",
                          h.event === "CREDITS_CONSUMED" ? "bg-emerald-400" : h.event === "CREDITS_EXHAUSTED" ? "bg-destructive" : "bg-amber-400",
                        )} />
                        {h.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.credits_consumed}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.matched ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.archived ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-70">
                      {h.message ?? (h.import_id ? `import ${h.import_id.slice(0, 8)}…` : h.campaign_id ? `campaign ${h.campaign_id.slice(0, 8)}…` : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
