"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Coins, Globe2, Sparkles, Bot, Search, Send } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { StatTile } from "@/components/ui/stat-tile";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
          Credits used
          <InfoTip side="bottom" text="What this campaign has used on each service. Only the AI number is recorded against the campaign. Apollo, Firecrawl, Jev and Tavily are worked out from this campaign's leads and their companies, so they are estimates." />
        </h3>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>

      {!data ? <StatTileGridSkeleton count={6} /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2">
            <StatTile label="Apollo" value={data.apollo.credits.toLocaleString()} icon={Coins} tone="sky" sub={`credits · ${data.leads} leads`} />
            <StatTile label="Firecrawl" value={data.firecrawl.credits.toLocaleString()} icon={Globe2} sub={`credits · ${data.companies} companies`} />
            <StatTile label="AI" value={usd(data.ai.usd)} icon={Sparkles} sub={`${data.ai.calls.toLocaleString()} calls${data.ai.failed ? ` · ${data.ai.failed} failed` : ""}`} />
            <StatTile label="Jev" value={usd(data.jev.usd)} icon={Bot} sub={`${data.jev.companies.toLocaleString()} companies scored`} />
            <StatTile label="Tavily" value={data.tavily.calls.toLocaleString()} icon={Search} sub={`${data.tavily.linkedinReads} LinkedIn · ${data.tavily.webSearches} searches`} />
            <StatTile label="Instantly" value={data.instantly.emailsSent.toLocaleString()} icon={Send} sub={`${data.instantly.openings.toLocaleString()} first + ${data.instantly.followUps.toLocaleString()} follow-ups`} />
          </div>

          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Service</TableHead>
                  <TableHead className="w-56">Used</TableHead>
                  <TableHead>What it covers</TableHead>
                  <TableHead className="w-28">Figure</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name} className="hover:bg-transparent">
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="tabular-nums">{r.used}</TableCell>
                    <TableCell className="text-muted-foreground">{r.how}</TableCell>
                    <TableCell>
                      <Pill
                        shape="sm"
                        className={r.exact
                          ? "bg-green-100 text-green-800 border-green-200/70 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/25"
                          : "bg-amber-100 text-amber-800 border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25"}
                      >
                        {r.exact ? "Counted" : "Estimated"}
                      </Pill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
