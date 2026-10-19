"use client";

import { Coins, CalendarDays, TrendingDown, Flame, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Paged } from "@/components/ui/paged";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  UsageHeader, UsageEmpty, UsageNotice, UsageProgress, UsageStatus, useCachedUsage,
} from "@/components/app/usage-header";
import { Panel } from "@/components/ui/panel";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
import {
  UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton,
} from "@/components/app/usage-skeletons";
import { fetchFirecrawlUsage, type FirecrawlUsageData } from "@/lib/api-client";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatDateTimeTz(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

export function FirecrawlUsageView() {
  const { data, loading, refreshing, load } = useCachedUsage<FirecrawlUsageData>("/api/v1/settings/keys/usage/firecrawl", fetchFirecrawlUsage);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <UsageHeaderSkeleton />
        <StatTileGridSkeleton count={4} />
        <StatTileGridSkeleton count={4} />
        <ChartCardSkeleton />
        <RowsCardSkeleton rows={5} />
      </div>
    );
  }

  const { key, credits, activity, daily, history, ledgerWindowDays } = data;
  const pctLeft =
    credits.remaining != null && credits.planCredits != null && credits.planCredits > 0
      ? Math.round((credits.remaining / credits.planCredits) * 100)
      : null;
  const usedPct =
    credits.usedThisCycle != null && credits.planCredits != null && credits.planCredits > 0
      ? Math.min(100, Math.round((credits.usedThisCycle / credits.planCredits) * 100))
      : null;

  return (
    <div className="space-y-6">
      <UsageHeader info="The balance comes live from Firecrawl (the same figures as their dashboard). The scrape activity below is this app's own record of company scrapes, which is useful if the key is shared with other tools." refreshing={refreshing} onRefresh={() => void load(true)} />

      {!key.ok && <UsageNotice tone="error">{key.message}</UsageNotice>}

      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Billing cycle</p>
          {credits.billingPeriodStart && credits.billingPeriodEnd ? (
            <>
              <p className="text-sm font-medium tabular-nums">
                {formatDate(credits.billingPeriodStart)} – {formatDate(credits.billingPeriodEnd)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Usage renews {formatDateTimeTz(credits.billingPeriodEnd)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No billing period reported (free plan or unknown)</p>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Credits remaining"
            value={credits.remaining != null ? credits.remaining.toLocaleString() : "—"}
            icon={Coins}
            tone={
              credits.remaining != null && credits.remaining <= 0
                ? "red"
                : pctLeft != null && pctLeft <= 20
                  ? "amber"
                  : "sky"
            }
            sub={pctLeft != null ? `${pctLeft}% of plan` : undefined}
          />
          <StatTile
            label="Plan credits"
            value={credits.planCredits != null ? credits.planCredits.toLocaleString() : "—"}
            icon={Flame}
            sub="excludes packs / auto-recharge"
          />
          <StatTile
            label="Used this cycle"
            value={credits.usedThisCycle != null ? credits.usedThisCycle.toLocaleString() : "—"}
            icon={TrendingDown}
            tone={usedPct != null && usedPct >= 90 ? "red" : usedPct != null && usedPct >= 60 ? "amber" : "neutral"}
            sub={usedPct != null ? `${usedPct}% of plan` : undefined}
          />
          <StatTile
            label="This app: scrapes (90d)"
            value={activity.allTime.toLocaleString()}
            icon={CalendarDays}
            sub={`${activity.success} ok · ${activity.failed + activity.empty} failed`}
          />
        </div>

        {credits.planCredits != null && credits.remaining != null && (
          <UsageProgress
            label="Plan credit usage"
            pct={usedPct ?? 0}
            value={<>
              {(credits.usedThisCycle ?? 0).toLocaleString()} / {credits.planCredits.toLocaleString()}
              <span className="text-muted-foreground"> · {credits.remaining.toLocaleString()} left</span>
            </>}
          />
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Scrapes today" value={activity.today} icon={Flame} />
        <StatTile label="Scrapes this week" value={activity.week} icon={CalendarDays} />
        <StatTile label="Scrapes this month" value={activity.month} icon={CalendarDays} tone="sky" />
        <StatTile
          label="Cache hits"
          value={activity.cacheHit}
          icon={CheckCircle2}
          sub={`last ${ledgerWindowDays}d · no credits used`}
        />
      </div>

      <Panel
        title="Scrape activity"
        description="Live Firecrawl calls this app made for org enrichment, last 14 days."
        aside={<span className="text-[13px] font-semibold text-foreground">{activity.allTime.toLocaleString()} total (90d)</span>}
      >
        {daily.every((d) => d.scrapes === 0) ? (
          <UsageEmpty>No Firecrawl scrapes recorded recently.</UsageEmpty>
        ) : (
          <UsageBarChart
            data={daily}
            bars={[
              { dataKey: "successes", name: "Succeeded", color: CHART_COLORS.primary },
              { dataKey: "failures", name: "Failed", color: CHART_COLORS.red },
            ]}
          />
        )}
      </Panel>

      <Panel title="Recent activity" description="Every org scrape attempt, most recent first.">
        {history.length === 0 ? (
          <UsageEmpty>No Firecrawl activity recorded yet.</UsageEmpty>
        ) : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Chars</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((h) => {
                  const tone =
                    h.event === "SCRAPE_SUCCESS" || h.event === "SCRAPE_CACHE_HIT"
                      ? "ok"
                      : h.event === "SCRAPE_FAILED"
                        ? "bad"
                        : "warn";
                  return (
                    <TableRow key={h.id} className={cn(tone !== "ok" && "text-muted-foreground")}>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(h.created_at)}</TableCell>
                      <TableCell><UsageStatus tone={tone}>{h.label}</UsageStatus></TableCell>
                      <TableCell className="truncate max-w-40">{h.domain ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {h.chars != null ? h.chars.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground truncate max-w-70">
                        {h.message ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          )}</Paged>
        )}
      </Panel>
    </div>
  );
}
