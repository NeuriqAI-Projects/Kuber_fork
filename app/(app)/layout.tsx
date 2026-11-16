import { AppProvider } from "@/lib/app-context";
import { AccessProvider } from "@/lib/access-context";
import { canSeeAll } from "@/lib/auth/scopes";
import { getLeadsCount } from "@/lib/server/leads-count";
import { requireAppSessionContext } from "@/lib/server/session";
import { ThemedAppShell } from "./app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Sequential rather than parallel: the lead count needs the company-scoped
  // client the session context resolves.
  const { session, db, member, userId } = await requireAppSessionContext();
  // Without leads:all the sidebar counts only their own leads (it showed the company total).
  const leadsTotal = member.scopes.includes("leads:read")
    ? await getLeadsCount(db, canSeeAll(member, "leads") ? undefined : { assignedTo: userId })
    : 0;

  return (
    <AccessProvider member={member}>
      <AppProvider initialSession={session} initialLeadsTotal={leadsTotal}>
        <ThemedAppShell>{children}</ThemedAppShell>
      </AppProvider>
    </AccessProvider>
  );
}
