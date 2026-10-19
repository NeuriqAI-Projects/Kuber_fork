"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { DashboardSkeleton } from "@/components/app/page-skeletons";
import { useApp } from "@/lib/app-context";
import { cacheKeys, cachedFetchers, useCached, type DashboardAnalyticsData } from "@/lib/api-client";

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
  const { session, role, campaigns, campaignsLoaded } = useApp();

  // Analytics: manager = company-wide, employee = own leads/campaigns (the
  // route picks by role). Imports are a manager-only card, as before.
  const analyticsQuery = useCached(
    session ? cacheKeys.dashboardAnalytics : null,
    cachedFetchers.dashboardAnalytics,
  );
  const importsQuery = useCached(
    session && role === "manager" ? cacheKeys.imports : null,
    cachedFetchers.imports,
  );
  const analytics = analyticsQuery.data ?? EMPTY_ANALYTICS;

  return (
    <DashboardView
      campaigns={campaigns}
      imports={role === "manager" ? (importsQuery.data ?? []) : []}
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
