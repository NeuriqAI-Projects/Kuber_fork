"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CampaignDetail } from "@/components/app/campaign-drawer";
import { useApp } from "@/lib/app-context";
import CampaignDetailLoading from "./loading";

interface Props {
  campaignId: string;
}

export function CampaignDetailClient({ campaignId }: Props) {
  const router = useRouter();
  const { campaigns, campaignsLoaded, loadCampaigns, session } = useApp();

  // The campaign row comes from the shared (cached) campaigns list, which has
  // live updates and the caller's role scoping. Only the very first visit,
  // before that list has ever loaded, shows the skeleton.
  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;

  // Header/tiles come from the cached list; refresh it quietly per visit.
  useEffect(() => {
    if (session) void loadCampaigns(session.access_token);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, [campaignId]);

  // Not in the cached list (e.g. created a moment ago in another tab): refetch
  // the list once before saying "not found".
  const missing = campaignsLoaded && !campaign;
  const [rechecked, setRechecked] = useState(false);
  useEffect(() => {
    if (!missing || rechecked || !session) return;
    void loadCampaigns(session.access_token).finally(() => setRechecked(true));
  }, [missing, rechecked, session, loadCampaigns]);

  if (!campaign && (!campaignsLoaded || !rechecked)) return <CampaignDetailLoading />;

  if (!campaign) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-24 gap-4">
        <p className="text-sm text-muted-foreground">Campaign not found.</p>
        <button
          type="button"
          onClick={() => router.push("/campaigns")}
          className="text-xs underline text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to campaigns
        </button>
      </div>
    );
  }

  return (
    <CampaignDetail
      key={campaign.id}
      campaign={campaign}
      onBack={() => router.push("/campaigns")}
    />
  );
}
