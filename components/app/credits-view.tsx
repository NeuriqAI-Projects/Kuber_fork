"use client";

import { useState } from "react";
import { Coins } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { InfoTip } from "@/components/ui/info-tip";
import { PageShell } from "@/components/ui/page-shell";
import { SettingsSection } from "@/components/ui/settings";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
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

export function CreditsView() {
  const { role } = useApp();
  const [tab, setTab] = useState<Tab>("apollo");

  if (role !== "manager") {
    return <p className="text-sm text-muted-foreground px-6 py-10 text-center">Only managers can see credits and keys.</p>;
  }
  const active = TABS.find((t) => t.id === tab);

  return (
    <PageShell
      title="Credits"
      icon={<Coins />}
      description={
        <span className="inline-flex items-center gap-1.5">
          Keys &amp; usage per service
          <InfoTip side="bottom" text="Each service has its own tab: its API key and what it has used. A service with no key set falls back to the matching value in .env.local." />
        </span>
      }
      subheader={
        <div className="shrink-0 px-4">
          <SegmentedTabs
            variant="underline"
            value={tab}
            onValueChange={setTab}
            options={TABS.map((t) => ({ value: t.id, label: t.label }))}
          />
        </div>
      }
      contentClassName="space-y-8"
    >
      {tab === "ai" ? (
        <>
          <SettingsSection title="Keys" description={active?.blurb} className="space-y-3"><LlmKeysPanel /></SettingsSection>
          <AiUsageView />
        </>
      ) : (
        <>
          <SettingsSection title="Key" description={active?.blurb} className="space-y-3"><ServiceKeysPanel key={tab} providerId={tab} /></SettingsSection>
          {tab === "apollo" && <ApolloUsageView />}
          {tab === "instantly" && <InstantlyUsageView />}
          {tab === "firecrawl" && <FirecrawlUsageView />}
          {tab === "jev" && <JevUsageView />}
          {tab === "tavily" && <TavilyUsageView />}
        </>
      )}
    </PageShell>
  );
}
