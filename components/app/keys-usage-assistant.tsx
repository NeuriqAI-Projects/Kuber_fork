"use client";

// Credits > AI: the Kuber AI assistant's models (per mode) and who used how much AI.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, Brain, Coins, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModelField } from "@/components/app/keys-view";
import { UsageEmpty, UsageNotice, useCachedUsage } from "@/components/app/usage-header";
import { Panel } from "@/components/ui/panel";
import { UsageBarChart, CHART_COLORS } from "@/components/app/usage-bar-chart";
import { StatTileGridSkeleton, ChartCardSkeleton } from "@/components/app/usage-skeletons";
import { useApp } from "@/lib/app-context";
import {
  fetchAssistantModels, fetchAssistantUsage, saveAssistantModel,
  type AssistantModelSettings, type AssistantUsageData, type ProviderConfig,
} from "@/lib/api-client";

const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

const PURPOSE_LABEL: Record<string, string> = {
  assistant: "Kuber AI assistant",
  draft: "Email drafts",
  followup: "Follow-ups",
  reply: "Reply drafts",
  enrichment: "Company profiles",
  classify: "Reply classification",
  other: "Other",
};

function relDay(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

/** A provider shaped the way the shared model picker expects. */
function pickerProvider(id: string, label: string, defaultModel: string): ProviderConfig {
  return {
    id, category: "llm", label, description: null,
    modelInputMode: "freeform", modelOptions: [], defaultModel, selectedModel: null, envFallback: false, keys: [],
  };
}

function ProviderModels({ p, onSaved }: { p: AssistantModelSettings["providers"][number]; onSaved: () => void }) {
  const { session } = useApp();
  const [fast, setFast] = useState(p.overrides.fast ?? p.defaults.fast);
  const [deep, setDeep] = useState(p.overrides.deep ?? p.defaults.deep);
  const [saving, setSaving] = useState(false);
  const dirty = fast !== (p.overrides.fast ?? p.defaults.fast) || deep !== (p.overrides.deep ?? p.defaults.deep);
  const isDefault = !p.overrides.fast && !p.overrides.deep;

  const save = async (patch: { fast?: string | null; deep?: string | null }) => {
    if (!session) return;
    setSaving(true);
    try {
      await saveAssistantModel(session.access_token, p.id, patch);
      toast.success(`${p.label}: assistant models saved`);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-medium">{p.label}</p>
        {!p.configured && <span className="text-xs text-muted-foreground">no key — skipped</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {!isDefault && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setFast(p.defaults.fast); setDeep(p.defaults.deep); void save({ fast: null, deep: null }); }}>
              Use defaults
            </Button>
          )}
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save({
            fast: fast === p.defaults.fast ? null : fast,
            deep: deep === p.defaults.deep ? null : deep,
          })}>
            Save
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Zap className="size-3" /> Fast mode — quick answers</p>
          <ModelField provider={pickerProvider(p.id, p.label, p.defaults.fast)} value={fast} onChange={setFast} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Brain className="size-3" /> Deep analysis — thorough answers</p>
          <ModelField provider={pickerProvider(p.id, p.label, p.defaults.deep)} value={deep} onChange={setDeep} />
        </div>
      </div>
      <p className="text-[11.5px] text-muted-foreground">Chat titles use {p.defaults.utility} (cheapest).</p>
    </div>
  );
}

export function AssistantModelsPanel() {
  const { session } = useApp();
  const [data, setData] = useState<AssistantModelSettings | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!session) return;
    fetchAssistantModels(session.access_token).then(setData).catch((e) => toast.error((e as Error).message));
  }, [session, version]);

  return (
    <Panel
      title="Kuber AI models"
      description="The assistant uses a fast model for quick answers and a stronger one for deep analysis. It follows the same Primary → Fallback order as drafting, so it works with whichever provider is up."
      flush
    >
      {!data ? (
        <div className="px-4 py-6 text-[13px] text-muted-foreground">Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          {data.providers.filter((p) => p.configured).map((p) => (
            <ProviderModels key={`${p.id}-${version}`} p={p} onSaved={() => setVersion((v) => v + 1)} />
          ))}
          {data.providers.every((p) => !p.configured) && (
            <div className="px-4 py-6 text-[13px] text-muted-foreground">Add an AI key above to turn the assistant on.</div>
          )}
        </div>
      )}
    </Panel>
  );
}

export function AssistantUsageView() {
  const [days, setDays] = useState(30);
  const { data, loading } = useCachedUsage<AssistantUsageData>(`/api/v1/assistant/usage?days=${days}`, (token) => fetchAssistantUsage(token, days));

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <StatTileGridSkeleton count={4} />
        <ChartCardSkeleton />
      </div>
    );
  }

  const assistant = data.by_purpose.find((p) => p.purpose === "assistant");
  const people = data.by_person.filter((p) => p.user_id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">AI spend</h3>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <Button key={d} size="sm" variant={d === days ? "secondary" : "ghost"} onClick={() => setDays(d)}>{d}d</Button>
          ))}
        </div>
      </div>

      {!data.per_person_available && (
        <UsageNotice tone="warning">
          Per-person usage starts after the database update in supabase/migrations/2026_10_19_assistant.sql is run. Totals below already work.
        </UsageNotice>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="All AI spend" value={money(data.total.cost_usd)} icon={Coins} sub={`${compact(data.total.calls)} calls · ${data.window_days}d`} />
        <StatTile label="Assistant spend" value={money(assistant?.cost_usd ?? 0)} icon={Bot} sub={`${compact(assistant?.calls ?? 0)} answers`} tone="sky" />
        <StatTile label="People using it" value={people.length} icon={Users} sub={`last ${data.window_days}d`} tone="amber" />
        <StatTile label="Tokens" value={compact(data.total.tokens)} icon={Zap} sub={data.total.failed ? `${data.total.failed} failed calls` : "all purposes"} tone="zinc" />
      </div>

      <Panel title="Assistant usage by person" description="Each answer is one call; deep analysis answers cost more than fast ones." flush>
        {data.by_person.length === 0 ? (
          <div className="p-4"><UsageEmpty>No one has used the assistant in this period.</UsageEmpty></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead className="text-right">Answers</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.by_person.map((p) => (
                <TableRow key={p.user_id ?? "unknown"}>
                  <TableCell>
                    <span className="font-medium">{p.name}</span>
                    {p.role && <span className="ml-1.5 text-xs text-muted-foreground capitalize">{p.role}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.calls.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{compact(p.tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.cost_usd)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{relDay(p.last_used)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel title="Daily AI spend" description={`US dollars per day, last ${data.window_days} days.`}>
        {data.daily.every((d) => d.assistant === 0 && d.other === 0) ? (
          <UsageEmpty>No AI spend recorded in this period.</UsageEmpty>
        ) : (
          <UsageBarChart
            data={data.daily.map((d) => ({ date: d.date.slice(5), assistant: d.assistant, other: d.other }))}
            bars={[
              { dataKey: "other", name: "Drafts & other", color: CHART_COLORS.primarySoft },
              { dataKey: "assistant", name: "Assistant", color: CHART_COLORS.primary },
            ]}
          />
        )}
      </Panel>

      <Panel title="Spend by purpose" flush>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.by_purpose.map((p) => (
              <TableRow key={p.purpose}>
                <TableCell>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</TableCell>
                <TableCell className="text-right tabular-nums">{p.calls.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{compact(p.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(p.cost_usd)}
                  {p.unpriced > 0 && <span className="ml-1 text-xs text-muted-foreground" title="Calls on a model with no known price">+{p.unpriced} unpriced</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
