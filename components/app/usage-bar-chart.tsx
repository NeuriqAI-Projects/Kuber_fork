"use client";

import dynamic from "next/dynamic";
import type { UsageBarSpec } from "@/components/app/usage-bar-chart-impl";

export type { UsageBarSpec };

/** Bar colours for every Usage chart: the theme primary plus tints mixed into
 *  the card colour (so they stay readable on white and on near-black), and
 *  mid-tone amber/red for "replies" / "failed". Lives here, not in the impl,
 *  so importing it never pulls recharts into the Credits bundle. */
export const CHART_COLORS = {
  primary: "var(--primary)",
  primarySoft: "color-mix(in oklab, var(--primary) 55%, var(--card))",
  primaryFaint: "color-mix(in oklab, var(--primary) 28%, var(--card))",
  amber: "#f59e0b",
  red: "#ef4444",
} as const;

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
