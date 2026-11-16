import { requirePageScope } from "@/lib/server/session";
import { DashboardClient } from "./dashboard-client";

// No server data load: the (app) layout already checked the session, and the
// client screen reads campaigns / analytics / imports through the cached
// /api/v1 endpoints (own vs company-wide by dashboard:all, decided by the routes),
// so navigating here paints at once instead of waiting on the database.
export default async function DashboardPage() {
  await requirePageScope("dashboard:read");
  return <DashboardClient />;
}
