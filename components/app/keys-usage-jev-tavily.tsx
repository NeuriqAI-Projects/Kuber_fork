"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, CalendarDays, Flame, Sparkles, Search, Link2 } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Paged } from "@/components/ui/paged";
import { Card } from "@/components/ui/card";
import { UsageHeader } from "@/components/app/usage-header";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton, RowsCardSkeleton } from "@/components/app/usage-skeletons";
import { fetchJevUsage, fetchTavilyUsage, type JevUsageData, type TavilyUsageData } from "@/lib/api-client";

const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** Load + refresh plumbing shared by both screens. */
function useUsage<T>(fetcher: (token: string, refresh: boolean) => Promise<T>) {
  const { session } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try { setData(await fetcher(session.access_token, refresh)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); setRefreshing(false); }
  }, [session, fetcher]);
  useEffect(() => { void load(false); }, [load]);
  return { data, loading, refreshing, load };
}

function Intro({ text, refreshing, onRefresh }: { text: string; refreshing: boolean; onRefresh: () => void }) {
  return <UsageHeader info={text} refreshing={refreshing} onRefresh={onRefresh} />;
}

const Loading = () => (
  <div className="space-y-6"><UsageHeaderSkeleton /><StatTileGridSkeleton count={4} /><ChartCardSkeleton /><RowsCardSkeleton rows={5} /></div>
);

function StatusPill({ status }: { status: string }) {
  const good = status === "good" || status === "approved" || status === "promoted";
  const bad = status === "hidden" || status === "rejected";
  return <span className={cn("inline-flex items-center gap-1.5", good ? "text-emerald-500" : bad ? "text-muted-foreground" : "text-amber-400")}>
    <span className={cn("size-1.5 rounded-full", good ? "bg-emerald-400" : bad ? "bg-muted-foreground" : "bg-amber-400")} />{status}</span>;
}

export function JevUsageView() {
  const { data, loading, refreshing, load } = useUsage<JevUsageData>(fetchJevUsage);
  if (loading || !data) return <Loading />;
  const { key, companies, tokens, usd: cost, daily, decisions, avgTokens, history, ledgerWindowDays } = data;
  return (
    <div className="space-y-6">
      <Intro refreshing={refreshing} onRefresh={() => void load(true)}
        text="Jev is the AI that decides whether a scored company makes plastic. It has no balance to read, only a key check, so the numbers below are what this app recorded: the tokens Jev read for each company it scored." />
      <div className={cn("rounded-lg border px-4 py-3 text-sm", key.ok ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400" : "border-destructive/30 bg-destructive/5 text-destructive")}>
        {key.message}
      </div>
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
      <Card className="p-5 space-y-3">
        <div><p className="eyebrow">Companies scored</p><p className="text-xs text-muted-foreground">Last 14 days.</p></div>
        {daily.every((d) => d.companies === 0)
          ? <p className="text-xs text-muted-foreground py-6 text-center">No companies scored recently.</p>
          : <UsageBarChart data={daily} bars={[{ dataKey: "companies", name: "Companies", color: "var(--primary)" }]} />}
      </Card>
      <Card className="p-5 space-y-3">
        <div><p className="eyebrow">Recent scoring</p><p className="text-xs text-muted-foreground">Most recent first.</p></div>
        {history.length === 0 ? <p className="text-xs text-muted-foreground py-6 text-center">Nothing scored yet.</p> : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground"><tr>
                <th className="text-left font-medium px-3 py-2">When</th><th className="text-left font-medium px-3 py-2">Company</th>
                <th className="text-left font-medium px-3 py-2">Decision</th><th className="text-right font-medium px-3 py-2">Score</th>
                <th className="text-right font-medium px-3 py-2">Tokens</th><th className="text-right font-medium px-3 py-2">Extra sources</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((h) => (
                  <tr key={h.id}>
                    <td className="px-3 py-2 whitespace-nowrap font-mono">{fmtTime(h.created_at)}</td>
                    <td className="px-3 py-2 truncate max-w-56">{h.name}</td>
                    <td className="px-3 py-2"><StatusPill status={h.status} /></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.score ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.tokens.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.extra || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}</Paged>
        )}
      </Card>
    </div>
  );
}

export function TavilyUsageView() {
  const { data, loading, refreshing, load } = useUsage<TavilyUsageData>(fetchTavilyUsage);
  if (loading || !data) return <Loading />;
  const { key, credits, calls, split, daily, history, ledgerWindowDays } = data;
  const usedPct = credits.used != null && credits.planCredits ? Math.min(100, Math.round((credits.used / credits.planCredits) * 100)) : null;
  return (
    <div className="space-y-6">
      <Intro refreshing={refreshing} onRefresh={() => void load(true)}
        text="Tavily reads LinkedIn pages when a company's website is down, and runs a web search when the AI is unsure. The balance is live from Tavily. The activity below is what Scored Companies recorded, so a read that came back too thin may be missing." />
      {!key.ok && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{key.message}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Credits remaining" value={credits.remaining != null ? credits.remaining.toLocaleString() : "—"} icon={Coins}
          tone={credits.remaining != null && credits.remaining <= 0 ? "red" : usedPct != null && usedPct >= 80 ? "amber" : "sky"}
          sub={credits.planCredits != null ? `of ${credits.planCredits.toLocaleString()} this month` : undefined} />
        <StatTile label="Used this month" value={credits.used != null ? credits.used.toLocaleString() : "—"} icon={Flame} sub={usedPct != null ? `${usedPct}% of plan` : undefined} />
        <StatTile label="This app: this month" value={calls.month} icon={CalendarDays} tone="sky" sub={`${calls.today} today · ${calls.week} this week`} />
        <StatTile label={`This app (${ledgerWindowDays}d)`} value={calls.allTime} icon={Search} sub={`${split.linkedinReads} LinkedIn · ${split.webSearches} searches`} />
      </div>
      {credits.planCredits != null && credits.used != null && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Plan usage this month (all apps on this key)</span>
            <span className="font-mono tabular-nums">{credits.used.toLocaleString()} / {credits.planCredits.toLocaleString()}</span>
          </div>
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className={cn("h-full rounded-full", (usedPct ?? 0) >= 90 ? "bg-destructive" : (usedPct ?? 0) >= 60 ? "bg-amber-400" : "bg-primary")} style={{ width: `${usedPct ?? 0}%` }} />
          </div>
        </div>
      )}
      <Card className="p-5 space-y-3">
        <div><p className="eyebrow">Tavily calls</p><p className="text-xs text-muted-foreground">Last 14 days, LinkedIn reads and web searches.</p></div>
        {daily.every((d) => d.linkedin + d.searches === 0)
          ? <p className="text-xs text-muted-foreground py-6 text-center">No Tavily calls recorded recently.</p>
          : <UsageBarChart data={daily} bars={[{ dataKey: "linkedin", name: "LinkedIn reads", color: "var(--primary)" }, { dataKey: "searches", name: "Web searches", color: "#f59e0b" }]} />}
      </Card>
      <Card className="p-5 space-y-3">
        <div><p className="eyebrow">Recent activity</p><p className="text-xs text-muted-foreground">Companies that used Tavily, most recent first.</p></div>
        {history.length === 0 ? <p className="text-xs text-muted-foreground py-6 text-center">No Tavily activity recorded yet.</p> : (
          <Paged items={history}>{(rows) => (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground"><tr>
                <th className="text-left font-medium px-3 py-2">When</th><th className="text-left font-medium px-3 py-2">Company</th>
                <th className="text-left font-medium px-3 py-2">Used for</th><th className="text-left font-medium px-3 py-2">Decision</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((h) => (
                  <tr key={h.id}>
                    <td className="px-3 py-2 whitespace-nowrap font-mono">{fmtTime(h.created_at)}</td>
                    <td className="px-3 py-2 truncate max-w-56">{h.name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2">
                        {h.linkedinRead && <span className="inline-flex items-center gap-1"><Link2 className="size-3" />LinkedIn read</span>}
                        {h.webSearch && <span className="inline-flex items-center gap-1"><Search className="size-3" />Web search</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2"><StatusPill status={h.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}</Paged>
        )}
      </Card>
    </div>
  );
}
