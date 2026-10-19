"use client";

import {
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Activity, ArrowRight, LayoutDashboard, Mail,
  Megaphone, Tags, TrendingUp, Users, Zap, Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getBatchColor, type BatchColorName } from "@/lib/constants";
import type { Campaign } from "@/components/app/create-campaign-modal";
import type { ImportBatch } from "@/lib/api-client";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

// ─── Chart helpers ────────────────────────────────────────────────────────────

const GRID_COLOR = "var(--border)";
const TICK_COLOR = "var(--muted-foreground)";

// Reply temperature: semantic hues at mid tones that read on white and on
// near-black; "unsubscribed" is the muted text colour so it never vanishes.
const TEMPERATURE_COLORS = {
  hot: "#ef4444",
  cold: "#3b82f6",
  ooo: "#f59e0b",
  unsubscribed: "var(--muted-foreground)",
};

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color?: string; payload?: { color?: string } }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-lg">
      {label && <p className="mb-1 font-medium text-muted-foreground">{label}</p>}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-[3px]"
            style={{ background: p.payload?.color ?? p.color ?? "var(--primary)" }}
          />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-foreground">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend row next to a donut: swatch, name, count, share. */
function LegendRow({ color, name, value, pct }: { color: string; name: string; value: number; pct: number }) {
  return (
    <div className="flex h-7 items-center gap-2 text-[13px]">
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{name}</span>
      <span className="font-medium tabular-nums">{value}</span>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
  campaigns: Campaign[];
  imports: ImportBatch[];
  loading?: boolean;
  totalLeads: number;
  leadsThisMonth?: number;
  enrichedLeads: number;
  hotCount: number;
  pipelineGrowth: Array<{ month: string; leads: number }>;
  stageDonutData: Array<{ name: string; value: number; color: string }>;
  temperatureBreakdown: { hot: number; cold: number; ooo: number; unsubscribed: number; unclassified: number } | null;
  pendingReplies: Array<{ id: string; campaignId: string; campaignName: string; leadEmail: string | null; preview: string; createdAt: string }>;
  onNavigate: (view: "lead-generation" | "leads" | "campaigns") => void;
  onSelectBatch: (label: string) => void;
}

export function DashboardView({
  campaigns,
  imports,
  loading = false,
  totalLeads,
  leadsThisMonth = 0,
  enrichedLeads,
  hotCount,
  pipelineGrowth,
  stageDonutData,
  temperatureBreakdown,
  pendingReplies,
  onNavigate,
  onSelectBatch,
}: DashboardViewProps) {
  const hotLeads      = hotCount;
  const liveCampaigns = campaigns.filter((c) => c.status === "Live").length;
  const totalReplied   = campaigns.reduce((a, c) => a + c.replied, 0);
  // DELIVERED, not `c.sent` — a replied or bounced lead has left `sent` for
  // its own bucket (see campaignOutcomes), so summing `sent` alone would
  // undercount every email that actually went out and got an outcome. Reply
  // rate divides by the same total for the same reason: dividing by `sent`
  // would shrink the base every time a campaign works and overstate the rate.
  const totalSent      = campaigns.reduce((a, c) => a + c.delivered, 0);
  const replyRate      = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const pulse = (w: string) => <span className={cn("inline-block h-6 rounded bg-secondary animate-pulse", w)} />;

  const temperatureData = temperatureBreakdown
    ? [
        { name: "Hot", value: temperatureBreakdown.hot, color: TEMPERATURE_COLORS.hot },
        { name: "Cold", value: temperatureBreakdown.cold, color: TEMPERATURE_COLORS.cold },
        { name: "Out of office", value: temperatureBreakdown.ooo, color: TEMPERATURE_COLORS.ooo },
        { name: "Unsubscribed", value: temperatureBreakdown.unsubscribed, color: TEMPERATURE_COLORS.unsubscribed },
      ].filter((d) => d.value > 0)
    : [];
  const temperatureTotal = temperatureData.reduce((a, d) => a + d.value, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Dashboard"
        icon={<LayoutDashboard />}
        actions={
          <>
            <span className="hidden text-[13px] tabular-nums text-muted-foreground md:inline">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </span>
            <Button size="sm" variant="outline" onClick={() => onNavigate("lead-generation")}>
              <Users /> Add leads
            </Button>
            <Button size="sm" onClick={() => onNavigate("campaigns")}>
              <Megaphone /> Campaigns
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl space-y-5 px-6 py-6">

          {/* Upstream credit/API-key failures (OpenRouter/Firecrawl/Apollo). */}
          <ServiceHealthBanner />

          {/* ── Headline numbers ── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Total leads" icon={Users}
              value={loading ? pulse("w-14") : totalLeads}
              sub={`${leadsThisMonth} added this month`}
            />
            <StatTile
              label="Hot leads" icon={Flame} tone="red"
              value={loading ? pulse("w-10") : hotLeads}
              sub={`${Math.round(hotLeads / Math.max(totalLeads, 1) * 100)}% of total`}
            />
            <StatTile
              label="Emails sent" icon={Mail} tone="sky"
              value={loading ? pulse("w-12") : totalSent}
              sub={`${campaigns.length} campaigns`}
            />
            <StatTile
              label="Reply rate" icon={Activity} tone="amber"
              value={loading ? pulse("w-10") : `${replyRate}%`}
              sub={`${totalReplied} replies total`}
            />
            <StatTile
              label="Live campaigns" icon={Megaphone}
              value={loading ? pulse("w-8") : liveCampaigns}
              sub={`${campaigns.length} total created`}
            />
            <StatTile
              label="Enriched" icon={Zap} tone="zinc"
              value={loading ? pulse("w-12") : enrichedLeads}
              sub={`${Math.round(enrichedLeads / Math.max(totalLeads, 1) * 100)}% done`}
            />
          </div>

          {/* ── Pipeline trend + stage split ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel
              truncate
              className="lg:col-span-2"
              title="Pipeline growth"
              description="Total leads, cumulative over the last 6 months"
              actions={<TrendingUp className="size-4 shrink-0 text-muted-foreground" />}
            >
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={pipelineGrowth} margin={{ left: -16, right: 4, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="areaPrimary" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="var(--primary)" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: TICK_COLOR, fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: TICK_COLOR, fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border)", strokeWidth: 1 }} />
                  <Area
                    isAnimationActive={false}
                    type="monotone" dataKey="leads" name="Leads" stroke="var(--primary)" strokeWidth={2}
                    fill="url(#areaPrimary)"
                    dot={false}
                    activeDot={{ r: 4, fill: "var(--primary)", strokeWidth: 2, stroke: "var(--card)" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>

            <Panel truncate title="Stage distribution" description="Leads across pipeline stages">
              {stageDonutData.length === 0 ? (
                <EmptyState
                  boxed={false}
                  message="No leads yet — add some to see the distribution"
                  className="h-[240px] py-0"
                />
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <ResponsiveContainer width={160} height={160}>
                    <PieChart>
                      <Pie
                        isAnimationActive={false}
                        data={stageDonutData} cx="50%" cy="50%"
                        innerRadius={50} outerRadius={74} paddingAngle={2} dataKey="value" strokeWidth={0}
                      >
                        {stageDonutData.map((d) => <Cell key={d.name} fill={d.color} />)}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="w-full">
                    {stageDonutData.map((d) => (
                      <LegendRow
                        key={d.name} color={d.color} name={d.name} value={d.value}
                        pct={Math.round((d.value / Math.max(totalLeads, 1)) * 100)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          </div>

          {/* ── Replies ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel truncate title="Reply temperature" description="How prospects who replied were classified">
              {temperatureData.length === 0 ? (
                <EmptyState boxed={false} message="No replies classified yet" className="h-[180px] py-0" />
              ) : (
                <div className="flex items-center gap-5">
                  <div className="shrink-0">
                    <ResponsiveContainer width={132} height={132}>
                      <PieChart>
                        <Pie isAnimationActive={false} data={temperatureData} cx="50%" cy="50%" innerRadius={40} outerRadius={62} paddingAngle={2} dataKey="value" strokeWidth={0}>
                          {temperatureData.map((d) => <Cell key={d.name} fill={d.color} />)}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="min-w-0 flex-1">
                    {temperatureData.map((d) => (
                      <LegendRow
                        key={d.name} color={d.color} name={d.name} value={d.value}
                        pct={Math.round((d.value / Math.max(temperatureTotal, 1)) * 100)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </Panel>

            <Panel
              truncate
              className="lg:col-span-2"
              bodyClassName="p-0"
              title="Needs your review"
              description="Reply drafts waiting for approval, across all campaigns"
              actions={
                pendingReplies.length > 0 ? (
                  <span className="rounded-[4px] bg-secondary px-1.5 py-0.5 text-xs font-medium tabular-nums">
                    {pendingReplies.length}
                  </span>
                ) : undefined
              }
            >
              {pendingReplies.length === 0 ? (
                <EmptyState boxed={false} icon={Mail} message="No replies waiting for review" className="h-[180px] py-0" />
              ) : (
                <div className="max-h-[288px] divide-y divide-border overflow-y-auto">
                  {pendingReplies.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onNavigate("campaigns")}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-[13px] font-medium">{r.leadEmail ?? "Unknown lead"}</p>
                          <span className="shrink-0 text-xs text-muted-foreground">{r.campaignName}</span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{r.preview}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* ── Batches + goals ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel
              truncate
              className="lg:col-span-2"
              bodyClassName="p-0"
              title="Batches"
              description="Click a batch to view its leads"
              actions={<Tags className="size-4 shrink-0 text-muted-foreground" />}
            >
              {imports.length === 0 ? (
                <EmptyState
                  boxed={false}
                  icon={Tags}
                  message="No batches yet. Import leads from Apollo, Excel, or manual entry to create one."
                  className="py-10"
                />
              ) : (
                <div className="max-h-[440px] divide-y divide-border overflow-y-auto">
                  {imports.map((b) => {
                    const bc = getBatchColor(b.color);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onSelectBatch(b.label)}
                        className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-hover"
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", bc.bg)} />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{b.label}</span>
                        <span className="hidden shrink-0 text-xs capitalize text-muted-foreground sm:inline">{b.source}</span>
                        <Pill color={b.color as BatchColorName} className="shrink-0 tabular-nums">
                          {b.lead_count} lead{b.lead_count !== 1 ? "s" : ""}
                        </Pill>
                      </button>
                    );
                  })}
                </div>
              )}
            </Panel>

            <div className="space-y-4">
              <Panel truncate title="Monthly goals" bodyClassName="space-y-4">
                {/* Leads is true month-to-date. Emails/Replies are lifetime campaign
                    counters — Instantly gives no per-month history and nothing local
                    records a send date, so there is no MTD figure to show.
                    ponytail: add a monthly send ledger if these need to be true MTD. */}
                {[
                  { label: "Leads added", current: leadsThisMonth, goal: 50,  period: "this month" },
                  { label: "Emails sent", current: totalSent,      goal: 100, period: "all time"   },
                  { label: "Replies",     current: totalReplied,   goal: 20,  period: "all time"   },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="mb-1.5 flex justify-between text-[13px]">
                      <span>
                        {item.label}
                        <span className="ml-1.5 text-xs text-muted-foreground">{item.period}</span>
                      </span>
                      <span className="font-medium tabular-nums text-muted-foreground">
                        {item.current >= item.goal
                          ? `${item.current} ✓`
                          : `${item.current}/${item.goal}`}
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(Math.round(item.current / item.goal * 100), 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </Panel>

              <Panel truncate title="Suggested actions" bodyClassName="p-1.5">
                <ul>
                  {[
                    { text: "Review leads awaiting approval", action: () => onNavigate("leads")           },
                    { text: "Enrich newly imported leads",    action: () => onNavigate("leads")           },
                    { text: "Create Q3 outreach campaign",    action: () => onNavigate("campaigns")       },
                    { text: "Add more leads via Apollo",      action: () => onNavigate("lead-generation") },
                  ].map((s) => (
                    <li key={s.text}>
                      <button
                        type="button"
                        onClick={s.action}
                        className="group flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                      >
                        <span className="flex-1 truncate">{s.text}</span>
                        <ArrowRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
