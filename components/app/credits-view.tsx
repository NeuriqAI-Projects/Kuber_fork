"use client";

import { useState } from "react";
import { useApp } from "@/lib/app-context";
import { InfoTip } from "@/components/ui/info-tip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LlmKeysPanel, ServiceKeysPanel } from "@/components/app/keys-view";
import { ApolloUsageView } from "@/components/app/keys-usage-apollo";
import { InstantlyUsageView } from "@/components/app/keys-usage-instantly";
import { AiUsageView } from "@/components/app/keys-usage-ai";
import { FirecrawlUsageView } from "@/components/app/keys-usage-firecrawl";
import { JevUsageView, TavilyUsageView } from "@/components/app/keys-usage-jev-tavily";

type Tab = "apollo" | "instantly" | "ai" | "firecrawl" | "jev" | "tavily";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "apollo", label: "Apollo", blurb: "Finds companies and people, and reveals their emails." },
  { id: "instantly", label: "Instantly", blurb: "Sends campaign emails and brings replies back." },
  { id: "ai", label: "AI", blurb: "Writes drafts and replies. OpenRouter, OpenAI and Claude share one try-order." },
  { id: "firecrawl", label: "Firecrawl", blurb: "Reads company websites." },
  { id: "jev", label: "Jev", blurb: "Scores whether a company makes plastic, before any email is bought." },
  { id: "tavily", label: "Tavily", blurb: "Reads LinkedIn pages and searches the web when a website says too little." },
];

function Section({ eyebrow, title, children }: { eyebrow: string; title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="px-1"><h3 className="font-display text-2xl font-bold tracking-tight flex items-center gap-2">{eyebrow}{title && <InfoTip side="bottom" text={title} />}</h3></div>
      {children}
    </section>
  );
}

export function CreditsView() {
  const { role } = useApp();
  const [tab, setTab] = useState<Tab>("apollo");

  if (role !== "manager") {
    return <p className="text-sm text-muted-foreground px-6 py-10 text-center">Only managers can see credits and keys.</p>;
  }
  const blurb = TABS.find((t) => t.id === tab)?.blurb;

  return (
    <div className="w-full p-6 space-y-6 enter">
      <div className="space-y-1">
        <p className="eyebrow px-1">Credits</p>
        <h2 className="font-display text-lg font-semibold px-1 flex items-center gap-1.5">Keys &amp; credits <InfoTip side="bottom" text="Each service has its own tab: its API key and what it has used. A service with no key set falls back to the matching value in .env.local." /></h2>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full max-w-2xl">
          {TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
        </TabsList>

        {(["apollo", "instantly", "firecrawl", "jev", "tavily"] as const).map((id) => (
          <TabsContent key={id} value={id} className="mt-6 space-y-8">
            {tab === id && (
              <>
                <Section eyebrow="Keys" title={blurb}><ServiceKeysPanel providerId={id} /></Section>
                <div>
                  {id === "apollo" && <ApolloUsageView />}
                  {id === "instantly" && <InstantlyUsageView />}
                  {id === "firecrawl" && <FirecrawlUsageView />}
                  {id === "jev" && <JevUsageView />}
                  {id === "tavily" && <TavilyUsageView />}
                </div>
              </>
            )}
          </TabsContent>
        ))}

        <TabsContent value="ai" className="mt-6 space-y-8">
          {tab === "ai" && (
            <>
              <Section eyebrow="Keys" title={blurb}><LlmKeysPanel /></Section>
              <div><AiUsageView /></div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
