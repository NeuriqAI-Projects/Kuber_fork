"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Gauge, Coins, CalendarDays, TrendingDown, Flame, CheckCircle2 } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart } from "@/components/app/usage-bar-chart";
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
  const { session } = useApp();
  const [data, setData] = useState<FirecrawlUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetchFirecrawlUsage(session.access_token, refresh);
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
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Credit balance below comes live from Firecrawl&apos;s account (same figures as their dashboard). The scrape
          activity further down is this app&apos;s own record of org enrichment scrapes — useful if the key is shared
          with other tools.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)} className="shrink-0 gap-1.5">
          <Gauge className={cn("size-3.5", refreshing && "animate-pulse")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>

      {!key.ok && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {key.message}
        </div>
      )}

      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="eyebrow">Billing cycle</p>
            {credits.billingPeriodStart && credits.billingPeriodEnd ? (
              <>
                <p className="text-sm font-medium">
                  {formatDate(credits.billingPeriodStart)} – {formatDate(credits.billingPeriodEnd)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Usage renews {formatDateTimeTz(credits.billingPeriodEnd)}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No billing period reported (free plan or unknown)</p>
            )}
          </div>
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
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Plan credit usage</span>
              <span className="font-mono tabular-nums">
                {(credits.usedThisCycle ?? 0).toLocaleString()} / {credits.planCredits.toLocaleString()}
                <span className="text-muted-foreground/70"> · {credits.remaining.toLocaleString()} left</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full",
                  (usedPct ?? 0) >= 90 ? "bg-destructive" : (usedPct ?? 0) >= 60 ? "bg-amber-400" : "bg-primary",
                )}
                style={{ width: `${usedPct ?? 0}%` }}
              />
            </div>
          </div>
        )}
      </Card>

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

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Scrape activity</p>
            <p className="text-xs text-muted-foreground">
              Live Firecrawl calls this app made for org enrichment, last 14 days.
            </p>
          </div>
          <p className="font-mono text-sm font-semibold tabular-nums">{activity.allTime.toLocaleString()} total (90d)</p>
        </div>
        {daily.every((d) => d.scrapes === 0) ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No Firecrawl scrapes recorded recently.</p>
        ) : (
          <UsageBarChart
            data={daily}
            bars={[
              { dataKey: "successes", name: "Succeeded", color: "var(--primary)" },
              { dataKey: "failures", name: "Failed", color: "#f87171" },
            ]}
          />
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <p className="eyebrow">Recent activity</p>
          <p className="text-xs text-muted-foreground">Every org scrape attempt, most recent first.</p>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No Firecrawl activity recorded yet.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">When</th>
                  <th className="text-left font-medium px-3 py-2">Event</th>
                  <th className="text-left font-medium px-3 py-2">Domain</th>
                  <th className="text-right font-medium px-3 py-2">Chars</th>
                  <th className="text-left font-medium px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((h) => {
                  const tone =
                    h.event === "SCRAPE_SUCCESS" || h.event === "SCRAPE_CACHE_HIT"
                      ? "ok"
                      : h.event === "SCRAPE_FAILED"
                        ? "bad"
                        : "warn";
                  return (
                    <tr key={h.id} className={cn(tone !== "ok" && "text-muted-foreground")}>
                      <td className="px-3 py-2 whitespace-nowrap font-mono">{formatDateTime(h.created_at)}</td>
                      <td className="px-3 py-2">
                        <span className={cn(
                          "inline-flex items-center gap-1.5",
                          tone === "ok" ? "text-emerald-500" : tone === "bad" ? "text-destructive" : "text-amber-400",
                        )}>
                          <span className={cn(
                            "size-1.5 rounded-full",
                            tone === "ok" ? "bg-emerald-400" : tone === "bad" ? "bg-destructive" : "bg-amber-400",
                          )} />
                          {h.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono truncate max-w-40">{h.domain ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {h.chars != null ? h.chars.toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-70">
                        {h.message ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
