import { CampaignDetailClient } from "./campaign-detail-client";

// No server data load: the campaign comes from the shared campaigns cache
// (/api/v1/campaigns), which applies the same access rule the old server load
// did — employees only see campaigns they created, are assigned, or hold a
// lead in, with counts overlaid for their own leads — so opening a campaign
// paints at once (instantly when the list is already cached).
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CampaignDetailClient campaignId={id} />;
}
