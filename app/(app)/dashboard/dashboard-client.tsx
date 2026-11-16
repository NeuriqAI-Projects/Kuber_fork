"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DashboardSkeleton } from "@/components/app/page-skeletons";
import { useApp } from "@/lib/app-context";
import { useAccess } from "@/lib/access-context";
import { cacheKeys, cachedFetchers, prefetch, useCached, type DashboardAnalyticsData } from "@/lib/api-client";

// recharts is only needed here — load it with the view instead of in the
// route's first bundle.
const DashboardView = dynamic(
  () => import("@/components/app/dashboard").then((m) => m.DashboardView),
  { ssr: false, loading: () => <DashboardSkeleton /> },
);

const EMPTY_ANALYTICS: DashboardAnalyticsData = {
  temperatureBreakdown: { hot: 0, cold: 0, ooo: 0, unsubscribed: 0, unclassified: 0 },
  pendingReplies: [],
  totalLeads: 0,
  leadsThisMonth: 0,
  enrichedLeads: 0,
  pipelineGrowth: [],
  stageDonutData: [],
};

export function DashboardClient() {
  const router = useRouter();
  const { session, campaigns, campaignsLoaded } = useApp();
  const showImports = useAccess().can("dashboard:all");

  // Campaign tiles: cached list now; reload only when it is stale (a write
  // touched it) or older than 30 s — a quick Dashboard revisit no longer
  // forces the full list again.
  useEffect(() => {
    if (session) prefetch(cacheKeys.campaigns, cachedFetchers.campaigns, { maxAgeMs: 30_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, []);

  // Analytics: company-wide with dashboard:all, else own leads/campaigns (the
  // route decides). The Imports card needs dashboard:all, as before.
  const analyticsQuery = useCached(
    session ? cacheKeys.dashboardAnalytics : null,
    cachedFetchers.dashboardAnalytics,
    { dedupeMs: 60_000 }, // 10 queries per load; writes still mark it stale
  );
  const importsQuery = useCached(
    session && showImports ? cacheKeys.imports : null,
    cachedFetchers.imports,
    { dedupeMs: 30_000 },
  );
  const analytics = analyticsQuery.data ?? EMPTY_ANALYTICS;

  return (
    <DashboardView
      campaigns={campaigns}
      imports={showImports ? (importsQuery.data ?? []) : []}
      loading={analyticsQuery.isLoading || !campaignsLoaded}
      totalLeads={analytics.totalLeads}
      leadsThisMonth={analytics.leadsThisMonth}
      enrichedLeads={analytics.enrichedLeads}
      hotCount={analytics.temperatureBreakdown.hot}
      pipelineGrowth={analytics.pipelineGrowth}
      stageDonutData={analytics.stageDonutData}
      temperatureBreakdown={analytics.temperatureBreakdown}
      pendingReplies={analytics.pendingReplies}
      onNavigate={(view) => router.push(view === "campaigns" ? "/campaigns" : "/leads")}
      onSelectBatch={(label) => router.push(`/leads?batches=${encodeURIComponent(label)}`)}
    />
  );
}
