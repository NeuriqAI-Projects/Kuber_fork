"use client";

import { Send, MailOpen, Reply, MailX, Inbox } from "lucide-react";
import { Paged } from "@/components/ui/paged";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UsageHeader, UsagePanel, UsageEmpty, UsageNotice, UsageStatus, useCachedUsage } from "@/components/app/usage-header";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton } from "@/components/app/usage-skeletons";
import { fetchInstantlyUsage, type InstantlyUsageData } from "@/lib/api-client";

const ACCOUNT_STATUS_LABEL: Record<number, { label: string; tone: "ok" | "warn" | "muted" }> = {
  1: { label: "Active", tone: "ok" },
  2: { label: "Paused", tone: "warn" },
  0: { label: "Inactive", tone: "muted" },
};

export function InstantlyUsageView() {
  const { data, loading, refreshing, load } = useCachedUsage<InstantlyUsageData>("/api/v1/settings/keys/usage/instantly", fetchInstantlyUsage);

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
      <UsageHeader info="Live from Instantly's analytics: sending accounts, workspace-wide send, open and reply totals, and a daily breakdown." refreshing={refreshing} onRefresh={() => void load(true)} />

      {!key.ok && <UsageNotice tone="error">{key.message}</UsageNotice>}

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
        <p className="text-[13px] text-muted-foreground">Campaign analytics overview unavailable: {overview.error}</p>
      )}

      <UsagePanel title="Send activity" description="Last 14 days across every campaign.">
        {daily.error ? (
          <p className="text-[13px] text-muted-foreground">Daily analytics unavailable: {daily.error}</p>
        ) : chartData.every((d) => d.sent === 0 && d.opened === 0 && d.replied === 0) ? (
          <UsageEmpty>No send activity in the last 14 days.</UsageEmpty>
        ) : (
          <UsageBarChart
            data={chartData}
            bars={[
              { dataKey: "sent", name: "Sent", color: CHART_COLORS.primary },
              { dataKey: "opened", name: "Opened", color: CHART_COLORS.primarySoft },
              { dataKey: "replied", name: "Replied", color: CHART_COLORS.amber },
            ]}
          />
        )}
      </UsagePanel>

      <UsagePanel
        title="Sending accounts"
        description="Mailboxes available to campaigns and their daily send caps."
        aside={
          <span className="flex items-center gap-1.5">
            <Inbox className="size-3.5" />
            {accounts.activeCount} / {accounts.totalCount} active · {accounts.totalDailyCapacity.toLocaleString()}/day capacity
          </span>
        }
      >
        {accounts.error ? (
          <p className="text-[13px] text-muted-foreground">Could not load sending accounts: {accounts.error}</p>
        ) : !accounts.data?.length ? (
          <UsageEmpty>No sending accounts configured.</UsageEmpty>
        ) : (
          <Paged items={accounts.data}>{(rows) => (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mailbox</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Daily limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const s = ACCOUNT_STATUS_LABEL[a.status] ?? { label: `Status ${a.status}`, tone: "muted" as const };
                  return (
                    <TableRow key={a.email}>
                      <TableCell>{a.email}</TableCell>
                      <TableCell><UsageStatus tone={s.tone}>{s.label}</UsageStatus></TableCell>
                      <TableCell className="text-right tabular-nums">{a.daily_limit ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          )}</Paged>
        )}
      </UsagePanel>
    </div>
  );
}
