"use client";

import { Sparkles, MessageSquareReply, ArrowRightLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageHeader, UsageEmpty, useCachedUsage } from "@/components/app/usage-header";
import { Panel } from "@/components/ui/panel";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton } from "@/components/app/usage-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAiUsage, type AiUsageData } from "@/lib/api-client";

function formatRemaining(id: string, remaining: number | null): string | null {
  if (remaining == null) return null;
  if (id === "openrouter") return `$${remaining.toFixed(2)} left`;
  return `${remaining} left`;
}

function ProviderRow({ provider }: { provider: AiUsageData["providers"][number] }) {
  const remaining = formatRemaining(provider.id, provider.remaining);
  const detail = provider.message && provider.message !== "OK" ? provider.message : provider.ok ? "Key is valid" : "No usable key configured";
  return (
    <div className="px-4 py-2.5 space-y-0.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("size-1.5 rounded-full shrink-0", provider.ok ? "bg-emerald-500" : "bg-destructive")} aria-hidden />
        <p className="font-medium text-[13px] truncate">{provider.label}</p>
        {remaining && (
          <span className={cn("ml-auto text-xs tabular-nums shrink-0", provider.ok ? "text-muted-foreground" : "text-destructive")}>
            {remaining}
          </span>
        )}
      </div>
      <p className={cn("text-xs pl-3.5", provider.ok ? "text-muted-foreground" : "text-destructive")}>{detail}</p>
    </div>
  );
}

export function AiUsageView() {
  const { data, loading, refreshing, load } = useCachedUsage<AiUsageData>("/api/v1/settings/keys/usage/ai", fetchAiUsage);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <UsageHeaderSkeleton />
        <Skeleton className="h-9 w-full rounded-lg" />
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-4 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-1.5 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <Skeleton className="h-3 w-48 ml-3.5" />
            </div>
          ))}
        </div>
        <StatTileGridSkeleton count={3} />
        <ChartCardSkeleton />
      </div>
    );
  }

  const { providers, tierRoles, volume } = data;
  const primaryLabel = providers.find((p) => p.id === tierRoles.primary)?.label ?? tierRoles.primary ?? "default order";
  const fallbackLabel = providers.find((p) => p.id === tierRoles.fallback)?.label ?? tierRoles.fallback ?? "none";

  return (
    <div className="space-y-6">
      <UsageHeader info="Key health for every configured LLM, plus how many drafts and replies this app has generated. Token and dollar spend is in AI spend above." refreshing={refreshing} onRefresh={() => void load(true)} />

      <div className="rounded-lg border border-border bg-secondary px-3.5 py-2.5 text-[13px] text-muted-foreground flex items-center gap-1.5">
        <ArrowRightLeft className="size-3.5 shrink-0" />
        Try order: <span className="font-medium text-foreground">{primaryLabel}</span> primary, <span className="font-medium text-foreground">{fallbackLabel}</span> fallback.
      </div>

      <Panel title="Key health" description="Every configured LLM, checked live.">
        <div className="-m-4 divide-y divide-border">
          {providers.map((p) => <ProviderRow key={p.id} provider={p} />)}
        </div>
      </Panel>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatTile label="Drafts generated" value={volume.totalDrafts} icon={Sparkles} sub={`last ${volume.windowDays}d`} />
        <StatTile label="Replies generated" value={volume.totalReplies} icon={MessageSquareReply} sub={`last ${volume.windowDays}d`} tone="sky" />
        <StatTile label="Total generations" value={volume.totalGenerations} icon={ArrowRightLeft} sub={`last ${volume.windowDays}d`} tone="amber" />
      </div>

      <Panel title="Generation volume" description={`Drafts and replies produced per day, last ${volume.windowDays} days.`}>
        {volume.daily.every((d) => d.drafts === 0 && d.replies === 0) ? (
          <UsageEmpty>No drafts or replies generated recently.</UsageEmpty>
        ) : (
          <UsageBarChart
            data={volume.daily}
            bars={[
              { dataKey: "drafts", name: "Drafts", color: CHART_COLORS.primary },
              { dataKey: "replies", name: "Replies", color: CHART_COLORS.amber },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
