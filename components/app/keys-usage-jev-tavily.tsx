"use client";

import { Coins, CalendarDays, Flame, Sparkles, Search, Link2 } from "lucide-react";
import { Paged } from "@/components/ui/paged";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  UsageHeader, UsageEmpty, UsageNotice, UsageProgress, UsageStatus, useCachedUsage,
} from "@/components/app/usage-header";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton } from "@/components/app/usage-skeletons";
import { fetchJevUsage, fetchTavilyUsage, type JevUsageData, type TavilyUsageData } from "@/lib/api-client";

const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

function Intro({ text, refreshing, onRefresh }: { text: string; refreshing: boolean; onRefresh: () => void }) {
  return <UsageHeader info={text} refreshing={refreshing} onRefresh={onRefresh} />;
}

const Loading = () => (
  <div className="space-y-6"><UsageHeaderSkeleton /><StatTileGridSkeleton count={4} /><ChartCardSkeleton /><RowsCardSkeleton rows={5} /></div>
);

function StatusPill({ status }: { status: string }) {
  const good = status === "good" || status === "approved" || status === "promoted";
  const bad = status === "hidden" || status === "rejected";
  return <UsageStatus tone={good ? "ok" : bad ? "muted" : "warn"}>{status}</UsageStatus>;
}

export function JevUsageView() {
  const { data, loading, refreshing, load } = useCachedUsage<JevUsageData>("/api/v1/settings/keys/usage/jev", fetchJevUsage);
  if (loading || !data) return <Loading />;
  const { key, companies, tokens, usd: cost, daily, decisions, avgTokens, history, ledgerWindowDays } = data;
  return (
    <div className="space-y-6">
      <Intro refreshing={refreshing} onRefresh={() => void load(true)}
        text="Jev is the AI that decides whether a scored company makes plastic. It has no balance to read, only a key check, so the numbers below are what this app recorded: the tokens Jev read for each company it scored." />
      <UsageNotice tone={key.ok ? "ok" : "error"}>{key.message}</UsageNotice>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Scored today" value={companies.today} icon={Flame} sub={usd(cost.today)} />
        <StatTile label="Scored this week" value={companies.week} icon={CalendarDays} sub={usd(cost.week)} />
        <StatTile label="Scored this month" value={companies.month} icon={CalendarDays} tone="sky" sub={usd(cost.month)} />
        <StatTile label={`Scored (${ledgerWindowDays}d)`} value={companies.allTime} icon={Sparkles} sub={`${usd(cost.allTime)} · ${tokens.allTime.toLocaleString()} tokens`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Avg tokens per company" value={avgTokens.toLocaleString()} icon={Coins} sub="about $0.042 per million" />
        {["good", "hidden", "review"].map((s) => <StatTile key={s} label={`Decided: ${s}`} value={decisions[s] ?? 0} icon={Sparkles} sub={`last ${ledgerWindowDays}d`} />)}
      </div>
      <Panel title="Companies scored" description="Last 14 days.">
        {daily.every((d) => d.companies === 0)
          ? <UsageEmpty>No companies scored recently.</UsageEmpty>
          : <UsageBarChart data={daily} bars={[{ dataKey: "companies", name: "Companies", color: CHART_COLORS.primary }]} />}
      </Panel>
      <Panel title="Recent scoring" description="Most recent first.">
        {history.length === 0 ? <UsageEmpty>Nothing scored yet.</UsageEmpty> : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead>When</TableHead><TableHead>Company</TableHead>
                <TableHead>Decision</TableHead><TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Extra sources</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtTime(h.created_at)}</TableCell>
                    <TableCell className="truncate max-w-56">{h.name}</TableCell>
                    <TableCell><StatusPill status={h.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{h.score ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.extra || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          )}</Paged>
        )}
      </Panel>
    </div>
  );
}

export function TavilyUsageView() {
  const { data, loading, refreshing, load } = useCachedUsage<TavilyUsageData>("/api/v1/settings/keys/usage/tavily", fetchTavilyUsage);
  if (loading || !data) return <Loading />;
  const { key, credits, calls, split, daily, history, ledgerWindowDays } = data;
  const usedPct = credits.used != null && credits.planCredits ? Math.min(100, Math.round((credits.used / credits.planCredits) * 100)) : null;
  return (
    <div className="space-y-6">
      <Intro refreshing={refreshing} onRefresh={() => void load(true)}
        text="Tavily reads LinkedIn pages when a company's website is down, and runs a web search when the AI is unsure. The balance is live from Tavily. The activity below is what Scored Companies recorded, so a read that came back too thin may be missing." />
      {!key.ok && <UsageNotice tone="error">{key.message}</UsageNotice>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Credits remaining" value={credits.remaining != null ? credits.remaining.toLocaleString() : "—"} icon={Coins}
          tone={credits.remaining != null && credits.remaining <= 0 ? "red" : usedPct != null && usedPct >= 80 ? "amber" : "sky"}
          sub={credits.planCredits != null ? `of ${credits.planCredits.toLocaleString()} this month` : undefined} />
        <StatTile label="Used this month" value={credits.used != null ? credits.used.toLocaleString() : "—"} icon={Flame} sub={usedPct != null ? `${usedPct}% of plan` : undefined} />
        <StatTile label="This app: this month" value={calls.month} icon={CalendarDays} tone="sky" sub={`${calls.today} today · ${calls.week} this week`} />
        <StatTile label={`This app (${ledgerWindowDays}d)`} value={calls.allTime} icon={Search} sub={`${split.linkedinReads} LinkedIn · ${split.webSearches} searches`} />
      </div>
      {credits.planCredits != null && credits.used != null && (
        <UsageProgress
          label="Plan usage this month (all apps on this key)"
          pct={usedPct ?? 0}
          value={`${credits.used.toLocaleString()} / ${credits.planCredits.toLocaleString()}`}
        />
      )}
      <Panel title="Tavily calls" description="Last 14 days, LinkedIn reads and web searches.">
        {daily.every((d) => d.linkedin + d.searches === 0)
          ? <UsageEmpty>No Tavily calls recorded recently.</UsageEmpty>
          : <UsageBarChart data={daily} bars={[{ dataKey: "linkedin", name: "LinkedIn reads", color: CHART_COLORS.primary }, { dataKey: "searches", name: "Web searches", color: CHART_COLORS.amber }]} />}
      </Panel>
      <Panel title="Recent activity" description="Companies that used Tavily, most recent first.">
        {history.length === 0 ? <UsageEmpty>No Tavily activity recorded yet.</UsageEmpty> : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead>When</TableHead><TableHead>Company</TableHead>
                <TableHead>Used for</TableHead><TableHead>Decision</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtTime(h.created_at)}</TableCell>
                    <TableCell className="truncate max-w-56">{h.name}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        {h.linkedinRead && <span className="inline-flex items-center gap-1"><Link2 className="size-3" />LinkedIn read</span>}
                        {h.webSearch && <span className="inline-flex items-center gap-1"><Search className="size-3" />Web search</span>}
                      </span>
                    </TableCell>
                    <TableCell><StatusPill status={h.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          )}</Paged>
        )}
      </Panel>
    </div>
  );
}
