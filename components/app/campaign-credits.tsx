"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Coins, Globe2, Sparkles, Bot, Search, Send } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { StatTile } from "@/components/ui/stat-tile";
import { StatTileGridSkeleton } from "@/components/app/usage-skeletons";
import { fetchCampaignCredits, type CampaignCreditsData } from "@/lib/api-client";

const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/** Campaign > Credits: what THIS campaign has used on each service, as one dashboard.
 *  Only the AI figure is tagged to the campaign; the rest are worked out from the campaign's
 *  leads and their companies (see the credits route), and marked "counted" or "estimated". */
export function CampaignCredits({ campaignId }: { campaignId: string }) {
  const { session } = useApp();
  const [data, setData] = useState<CampaignCreditsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true);
    try { setData(await fetchCampaignCredits(session.access_token, campaignId)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  }, [session, campaignId]);
  useEffect(() => { void load(); }, [load]);

  const rows = data ? [
    { name: "Apollo", used: `${data.apollo.credits.toLocaleString()} credits`, how: "Email reveals for this campaign's leads", exact: data.apollo.exact },
    { name: "Firecrawl", used: `${data.firecrawl.credits.toLocaleString()} credits`, how: "Company websites read", exact: data.firecrawl.exact },
    { name: "AI", used: `${usd(data.ai.usd)} · ${data.ai.calls.toLocaleString()} calls`, how: "Drafts, follow-ups and replies written for this campaign", exact: data.ai.exact },
    { name: "Jev", used: `${usd(data.jev.usd)} · ${data.jev.companies.toLocaleString()} companies`, how: "Companies scored before they became leads", exact: data.jev.exact },
    { name: "Tavily", used: `${data.tavily.calls.toLocaleString()} calls`, how: <><b className="font-semibold text-foreground">{data.tavily.linkedinReads}</b> LinkedIn reads · <b className="font-semibold text-foreground">{data.tavily.webSearches}</b> web searches</>, exact: data.tavily.exact },
    { name: "Instantly", used: `${data.instantly.emailsSent.toLocaleString()} emails`, how: <><b className="font-semibold text-foreground">{data.instantly.openings.toLocaleString()}</b> first emails + <b className="font-semibold text-foreground">{data.instantly.followUps.toLocaleString()}</b> follow-ups (Instantly has no credits)</>, exact: data.instantly.exact },
  ] : [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-secondary px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow flex items-center gap-1.5">
          Credits used
          <InfoTip side="bottom" text="What this campaign has used on each service. Only the AI number is recorded against the campaign. Apollo, Firecrawl, Jev and Tavily are worked out from this campaign's leads and their companies, so they are estimates." />
        </h3>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)} className="gap-1.5">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>

      {!data ? <StatTileGridSkeleton count={6} /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatTile label="Apollo" value={data.apollo.credits.toLocaleString()} icon={Coins} tone="sky" sub={`credits · ${data.leads} leads`} />
            <StatTile label="Firecrawl" value={data.firecrawl.credits.toLocaleString()} icon={Globe2} sub={`credits · ${data.companies} companies`} />
            <StatTile label="AI" value={usd(data.ai.usd)} icon={Sparkles} sub={`${data.ai.calls.toLocaleString()} calls${data.ai.failed ? ` · ${data.ai.failed} failed` : ""}`} />
            <StatTile label="Jev" value={usd(data.jev.usd)} icon={Bot} sub={`${data.jev.companies.toLocaleString()} companies scored`} />
            <StatTile label="Tavily" value={data.tavily.calls.toLocaleString()} icon={Search} sub={`${data.tavily.linkedinReads} LinkedIn · ${data.tavily.webSearches} searches`} />
            <StatTile label="Instantly" value={data.instantly.emailsSent.toLocaleString()} icon={Send} sub={`${data.instantly.openings.toLocaleString()} first + ${data.instantly.followUps.toLocaleString()} follow-ups`} />
          </div>

          <div className="rounded-xl border border-border bg-field dark:bg-card overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Service</th>
                  <th className="text-left font-medium px-4 py-2">Used</th>
                  <th className="text-left font-medium px-4 py-2">What it covers</th>
                  <th className="text-left font-medium px-4 py-2">Figure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">{r.used}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.how}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        r.exact ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400")}>
                        {r.exact ? "Counted" : "Estimated"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
