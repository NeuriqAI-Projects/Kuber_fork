"use client";

import dynamic from "next/dynamic";
import type { UsageBarSpec } from "@/components/app/usage-bar-chart-impl";

export type { UsageBarSpec };

// recharts loads with the first chart that renders, not with the Credits route.
// The placeholder takes the chart's height so the card doesn't jump.
const UsageBarChartImpl = dynamic(
  () => import("@/components/app/usage-bar-chart-impl").then((m) => m.UsageBarChart),
  { ssr: false, loading: () => <div style={{ width: "100%", height: 200 }} aria-busy="true" /> },
);

/** Shared daily bar chart for Settings > Keys > Usage (see usage-bar-chart-impl.tsx). */
export function UsageBarChart(props: {
  data: Record<string, string | number>[];
  bars: UsageBarSpec[];
  height?: number;
}) {
  return <UsageBarChartImpl {...props} />;
}
