"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Pencil, Coins, CalendarDays, TrendingDown, Zap } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Paged } from "@/components/ui/paged";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  UsageHeader, UsagePanel, UsageEmpty, UsageNotice, UsageProgress, UsageStatus, useCachedUsage,
} from "@/components/app/usage-header";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
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

/** Apollo can leave a pool out, or send only some of its numbers (seen live: `limit` missing).
 *  Missing counts as 0 so one odd pool never crashes the whole Usage screen. */
const n0 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

function CreditPoolRow({ label, w: raw }: { label: string; w: Partial<ApolloCreditWindow> | undefined }) {
  const w = { limit: n0(raw?.limit), consumed: n0(raw?.consumed), left_over: n0(raw?.left_over) };
  if (w.limit === 0 && w.consumed === 0) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">not on plan</span>
      </div>
    );
  }
  const pct = w.limit > 0 ? Math.min(100, Math.round((w.consumed / w.limit) * 100)) : 0;
  return (
    <UsageProgress
      label={label}
      pct={pct}
      value={<>
        {w.consumed.toLocaleString()} / {w.limit.toLocaleString()}
        <span className="text-muted-foreground"> · {w.left_over.toLocaleString()} left</span>
      </>}
    />
  );
}

/** Editable "monthly credit budget" — the only way "remaining" can be shown
 *  at all, since Apollo's API has no balance endpoint (see the route's own
 *  comment). A primary button opens a small dialog for the single number. */
function AllowanceEditor({
  allowance, onSave,
}: {
  allowance: number | null;
  onSave: (value: number | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(allowance != null ? String(allowance) : "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setValue(allowance != null ? String(allowance) : ""); }, [open, allowance]);

  async function save(next: number | null) {
    setSaving(true);
    try { await onSave(next); setOpen(false); }
    catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  }

  const n = value.trim() === "" ? null : Number(value);
  const valid = n === null || (Number.isFinite(n) && n >= 0);

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
        {allowance != null ? `Budget: ${allowance.toLocaleString()}/mo` : "Set monthly budget"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Monthly credit budget</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Apollo has no balance to read for this app, so set the credits you plan to use each month. The remaining-vs-budget tile is worked out from it.
            </p>
            <Input
              type="number" min={0} value={value} autoFocus
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 10000"
            />
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={saving || allowance == null} onClick={() => void save(null)}>
                Clear budget
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="button" size="sm" disabled={saving || !valid} onClick={() => void save(n)}>Save</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
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
        <span className="text-muted-foreground">no data</span>
      </div>
    );
  }
  const pct = w.limit > 0 ? Math.min(100, Math.round((w.consumed / w.limit) * 100)) : 0;
  return <UsageProgress label={label} pct={pct} value={`${w.consumed} / ${w.limit} ${windowLabel}`} />;
}

export function ApolloUsageView() {
  const { session } = useApp();
  const { data, loading, refreshing, load } = useCachedUsage<ApolloUsageData>("/api/v1/settings/keys/usage/apollo", fetchApolloUsage);

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
    key, consumed, byFeature, allowanceMonthly, remainingThisMonth, daily, rateLimits, rateLimitsError,
    creditUsage, creditCycle, creditUsageError, history,
  } = data;

  // Apollo's rate-limit payload lists every endpoint the account can call —
  // this app calls bulk_match (email reveal), mixed_people search and mixed_companies search (company search),
  // so only those are worth showing instead of a 30-row wall of zeros.
  const relevantLimits = (rateLimits ?? []).filter(
    (r) => r.action === "bulk_match" || (r.action === "api_search" && r.resource === "mixed_people") || r.resource === "mixed_companies",
  );

  const chartData = daily.map((d) => ({ date: d.date, credits: d.credits }));

  const rawLead = creditUsage?.lead_credit;
  const lead = rawLead ? { limit: n0(rawLead.limit), consumed: n0(rawLead.consumed), left_over: n0(rawLead.left_over) } : undefined;
  const leadPctLeft = lead && lead.limit > 0 ? Math.round((lead.left_over / lead.limit) * 100) : null;

  return (
    <div className="space-y-6">
      <UsageHeader
        info="Team credits come live from Apollo (the same figures as Apollo's own Settings > Usage page). The activity below is this app's own record of what it spent, which is useful if the account is shared with other tools or seats."
        refreshing={refreshing}
        onRefresh={() => void load(true)}
        extra={
          <AllowanceEditor
            allowance={allowanceMonthly}
            onSave={async (v) => {
              if (!session) return;
              await setApolloCreditAllowance(session.access_token, v);
              await load(false);
            }}
          />
        }
      />

      {!key.ok && <UsageNotice tone="error">{key.message}</UsageNotice>}

      {creditUsageError ? (
        <UsageNotice tone="warning">
          Could not read live team credits ({creditUsageError}) — this endpoint requires a Master API key. Falling back to
          this app&apos;s own ledger below.
        </UsageNotice>
      ) : creditUsage && creditCycle ? (
        <div className="space-y-4">
          <div>
            <p className="text-xs text-muted-foreground">Billing cycle</p>
            <p className="text-sm font-medium tabular-nums">{formatDate(creditCycle.start_date)} – {formatDate(creditCycle.end_date)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Usage renews {formatDateTimeTz(creditCycle.end_date)}</p>
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
              value={n0(creditUsage.ai_credit?.consumed).toLocaleString()}
              icon={Zap}
              sub={`of ${n0(creditUsage.ai_credit?.limit).toLocaleString()}/mo`}
            />
            <StatTile
              label="Conversation minutes used"
              value={n0(creditUsage.conversation_credit?.consumed).toLocaleString()}
              icon={CalendarDays}
              sub={`of ${n0(creditUsage.conversation_credit?.limit).toLocaleString()}/mo`}
            />
          </div>

          <UsagePanel title="All credit pools" description="Live from Apollo.">
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3.5">
              {(Object.keys(CREDIT_POOL_LABELS) as (keyof ApolloCreditUsageStats)[]).map((k) => (
                <CreditPoolRow key={k} label={CREDIT_POOL_LABELS[k]} w={creditUsage[k]} />
              ))}
            </div>
          </UsagePanel>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">Loading live team credits…</p>
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

      <div>
        <p className="mb-2 text-[13px] font-medium">This app: credits by feature (this month)</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatTile label="Scored companies search" value={byFeature.month.scored_search.credits} icon={Coins}
            sub={`${byFeature.month.scored_search.calls} search${byFeature.month.scored_search.calls === 1 ? "" : "es"} · ${byFeature.allTime.scored_search.credits} in 90d`} />
          <StatTile label="Company lookup search" value={byFeature.month.company_search.credits} icon={Coins}
            sub={`${byFeature.month.company_search.calls} search${byFeature.month.company_search.calls === 1 ? "" : "es"} · ${byFeature.allTime.company_search.credits} in 90d`} />
          <StatTile label="Email reveals" value={byFeature.month.email_reveal.credits} icon={Coins}
            sub={`${byFeature.month.email_reveal.calls} batch${byFeature.month.email_reveal.calls === 1 ? "" : "es"} · ${byFeature.allTime.email_reveal.credits} in 90d`} />
        </div>
      </div>

      <UsagePanel
        title="Credits consumed"
        description="Last 14 days, from every email reveal and company search this app has run."
        aside={<span className="text-[13px] font-semibold text-foreground">{consumed.allTime.toLocaleString()} total (90d)</span>}
      >
        <UsageBarChart data={chartData} bars={[{ dataKey: "credits", name: "Credits", color: CHART_COLORS.primary }]} />
      </UsagePanel>

      <UsagePanel
        title="API rate limits"
        description={<>Live from Apollo&apos;s usage_stats endpoint — the closest thing to &quot;usage&quot; their API actually exposes.</>}
      >
        {rateLimitsError ? (
          <p className="text-[13px] text-muted-foreground">
            Could not read rate limits ({rateLimitsError}) — this endpoint requires a Master API key.
          </p>
        ) : relevantLimits.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No email-reveal or search calls recorded by Apollo yet today.</p>
        ) : (
          <div className="space-y-3.5">
            {relevantLimits.map((r) => (
              <RateLimitRow key={`${r.resource}-${r.action}`} label={`${r.resource} · ${r.action}`} endpoint={r} />
            ))}
          </div>
        )}
      </UsagePanel>

      <UsagePanel title="Recent activity" description="Every email reveal, company search and skipped/failed attempt, most recent first.">
        {history.length === 0 ? (
          <UsageEmpty>No Apollo activity recorded yet.</UsageEmpty>
        ) : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Archived</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((h) => (
                  <TableRow key={h.id} className={cn(h.credits_consumed === 0 && h.event !== "CREDITS_CONSUMED" ? "text-muted-foreground" : "")}>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(h.created_at)}</TableCell>
                    <TableCell>
                      <UsageStatus tone={h.event === "CREDITS_CONSUMED" ? "ok" : h.event === "CREDITS_EXHAUSTED" ? "bad" : "warn"}>
                        {h.label}
                      </UsageStatus>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{h.credits_consumed}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.matched ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.archived ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground truncate max-w-70">
                      {h.message ?? h.detail ?? (h.import_id ? `import ${h.import_id.slice(0, 8)}…` : h.campaign_id ? `campaign ${h.campaign_id.slice(0, 8)}…` : "—")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          )}</Paged>
        )}
      </UsagePanel>
    </div>
  );
}
