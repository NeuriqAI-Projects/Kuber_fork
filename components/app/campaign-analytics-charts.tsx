"use client";

// The campaign Analytics tab's recharts pieces, split out of campaign-drawer.tsx
// so recharts loads only when that tab draws a chart (campaign-drawer imports
// these through next/dynamic). Markup is unchanged from the inline versions.

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis } from "recharts";

export type DonutSlice = { name: string; value: number; fill: string; opacity: number };
export type BarDatum = { name: string; v: number; fill: string; opacity: number };

/** 140px donut with a name: value tooltip (Pipeline, Lead temperature). */
export function CampaignDonutChart({ data }: { data: DonutSlice[] }) {
  return (
    <ResponsiveContainer width="45%" height={140}>
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={36} outerRadius={58} paddingAngle={2} dataKey="value" stroke="none">
          {data.map((s, i) => <Cell key={i} fill={s.fill} fillOpacity={s.opacity} />)}
        </Pie>
        <Tooltip
          content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                <span className="font-semibold">{payload[0].name}: </span>
                <span>{payload[0].value}</span>
              </div>
            ) : null
          }
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** 140px bar chart with a label: value tooltip (Draft funnel, Delivered vs Replied). */
export function CampaignBarChart({ data }: { data: BarDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -28, bottom: 0 }}>
        <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                <span className="font-semibold">{label}: </span>
                <span>{payload[0].value}</span>
              </div>
            ) : null
          }
        />
        <Bar dataKey="v" radius={[3, 3, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.fill} fillOpacity={d.opacity} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
