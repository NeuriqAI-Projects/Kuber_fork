"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Send, MailOpen, Reply, MailX, Inbox } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton } from "@/components/app/usage-skeletons";
import { fetchInstantlyUsage, type InstantlyUsageData } from "@/lib/api-client";

const ACCOUNT_STATUS_LABEL: Record<number, { label: string; tone: string }> = {
  1: { label: "Active", tone: "text-emerald-500" },
  2: { label: "Paused", tone: "text-amber-400" },
  0: { label: "Inactive", tone: "text-muted-foreground" },
};

export function InstantlyUsageView() {
  const { session } = useApp();
  const [data, setData] = useState<InstantlyUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetchInstantlyUsage(session.access_token, refresh);
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
        <ChartCardSkeleton />
        <RowsCardSkeleton rows={4} />
      </div>
    );
  }

  const { key, accounts, overview, daily } = data;
  const chartData = (daily.data ?? []).map((d) => ({
    date: d.date, sent: d.sent ?? 0, opened: d.unique_opened ?? 0, replied: d.unique_replies ?? 0,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Live from Instantly&apos;s campaign analytics API — sending accounts, workspace-wide send/open/reply totals, and a daily breakdown.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)} className="shrink-0 gap-1.5">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>

      {!key.ok && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {key.message}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Emails sent" value={overview.data?.emails_sent_count ?? "—"} icon={Send} />
        <StatTile label="Unique opens" value={overview.data?.open_count_unique ?? "—"} icon={MailOpen} tone="sky" />
        <StatTile label="Unique replies" value={overview.data?.reply_count_unique ?? "—"} icon={Reply} tone="amber" />
        <StatTile
          label="Bounced"
          value={overview.data?.bounced_count ?? "—"}
          icon={MailX}
          tone={overview.data?.bounced_count ? "red" : "neutral"}
        />
      </div>
      {overview.error && (
        <p className="text-xs text-muted-foreground">Campaign analytics overview unavailable: {overview.error}</p>
      )}

      <Card className="p-5 space-y-3">
        <div>
          <p className="eyebrow">Send activity</p>
          <p className="text-xs text-muted-foreground">Last 14 days across every campaign.</p>
        </div>
        {daily.error ? (
          <p className="text-xs text-muted-foreground">Daily analytics unavailable: {daily.error}</p>
        ) : chartData.every((d) => d.sent === 0 && d.opened === 0 && d.replied === 0) ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No send activity in the last 14 days.</p>
        ) : (
          <UsageBarChart
            data={chartData}
            bars={[
              { dataKey: "sent", name: "Sent", color: "var(--primary)" },
              { dataKey: "opened", name: "Opened", color: "#38bdf8" },
              { dataKey: "replied", name: "Replied", color: "#fbbf24" },
            ]}
          />
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Sending accounts</p>
            <p className="text-xs text-muted-foreground">Mailboxes available to campaigns and their daily send caps.</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Inbox className="size-3.5" />
            {accounts.activeCount} / {accounts.totalCount} active · {accounts.totalDailyCapacity.toLocaleString()}/day capacity
          </div>
        </div>
        {accounts.error ? (
          <p className="text-xs text-muted-foreground">Could not load sending accounts: {accounts.error}</p>
        ) : !accounts.data?.length ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No sending accounts configured.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Mailbox</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-right font-medium px-3 py-2">Daily limit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accounts.data.map((a) => {
                  const s = ACCOUNT_STATUS_LABEL[a.status] ?? { label: `Status ${a.status}`, tone: "text-muted-foreground" };
                  return (
                    <tr key={a.email}>
                      <td className="px-3 py-2 font-mono">{a.email}</td>
                      <td className={cn("px-3 py-2", s.tone)}>{s.label}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{a.daily_limit ?? "—"}</td>
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
