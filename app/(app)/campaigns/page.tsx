import { CampaignsClient } from "./campaigns-client";

// No server data load: the list comes from the shared campaigns cache
// (/api/v1/campaigns — employees get only campaigns they own or hold leads in,
// with their own counts, same rule as before), so this paints instantly.
export default function CampaignsPage() {
  return <CampaignsClient />;
}
