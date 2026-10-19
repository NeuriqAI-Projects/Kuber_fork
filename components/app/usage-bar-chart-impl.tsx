"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const GRID_COLOR = "var(--border)";
const TICK_COLOR = "var(--muted-foreground)";

export type UsageBarSpec = { dataKey: string; name: string; color: string };

function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-lg">
      {label && <p className="mb-1 font-medium text-muted-foreground">{shortDate(label)}</p>}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-foreground">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Shared daily bar chart for Settings > Keys > Usage — one small component
 *  instead of re-deriving recharts boilerplate per provider tab. */
export function UsageBarChart({
  data,
  bars,
  height = 200,
}: {
  data: Record<string, string | number>[];
  bars: UsageBarSpec[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: -10, right: 4, top: 4, bottom: 0 }}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDate}
          tick={{ fill: TICK_COLOR, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          interval={Math.max(0, Math.floor(data.length / 7) - 1)}
        />
        <YAxis tick={{ fill: TICK_COLOR, fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hover)" }} />
        {bars.map((b) => (
          <Bar key={b.dataKey} isAnimationActive={false} dataKey={b.dataKey} name={b.name} fill={b.color} radius={[3, 3, 0, 0]} maxBarSize={22} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
