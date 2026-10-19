import { DashboardClient } from "./dashboard-client";

// No server data load: the (app) layout already checked the session, and the
// client screen reads campaigns / analytics / imports through the cached
// /api/v1 endpoints (same manager vs employee scoping, decided by the routes),
// so navigating here paints at once instead of waiting on the database.
export default function DashboardPage() {
  return <DashboardClient />;
}
