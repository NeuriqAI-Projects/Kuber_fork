"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, Users, Megaphone, Settings, Inbox, FlaskConical,
  PanelLeft, Bug, Coins, Search, User,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CommandMenu, type CommandGroup } from "@/components/ui/command-menu";
import { useApp } from "@/lib/app-context";
import { ThemeProvider } from "@/lib/theme-context";
import { APP_LOGO_INITIAL, APP_NAME, BRAND_LOGO_CHANGED } from "@/lib/branding";
import { isCampaignEligible, type Lead } from "@/lib/leads";
import { deleteLead, fetchLogo, fetchUniboxUnread, fetchApolloCredits } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const CreateCampaignModal = dynamic(
  () => import("@/components/app/create-campaign-modal").then((m) => m.CreateCampaignModal),
  { ssr: false },
);
const LeadDrawer = dynamic(
  () => import("@/components/app/lead-drawer").then((m) => m.LeadDrawer),
  { ssr: false },
);
const OrgDrawer = dynamic(
  () => import("@/components/app/org-drawer").then((m) => m.OrgDrawer),
  { ssr: false },
);
const AddLeadsDrawer = dynamic(
  () => import("@/components/app/add-leads-drawer").then((m) => m.AddLeadsDrawer),
  { ssr: false },
);

const SIDEBAR_COLLAPSED_KEY = "kuber_sidebar_collapsed";
const BUG_REPORT_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdzYy8kUC3a9JSyhrWZJjvrmde9V3qBVycKMRSpLLUpQqkWug/viewform";

// Sidebar groups, Attio-style: a top group, "Records", then "Workspace".
const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard",  icon: LayoutDashboard, exact: true,  managerOnly: false, group: "main"      },
  { href: "/unibox",    label: "Unibox",     icon: Inbox,           exact: false, managerOnly: false, group: "main"      },
  { href: "/leads",     label: "Leads",      icon: Users,           exact: false, managerOnly: false, group: "records"   },
  { href: "/campaigns", label: "Campaigns",  icon: Megaphone,       exact: false, managerOnly: false, group: "records"   },
  // Managers only: the lab spends on model calls and decides what writes to
  // customers. It never sends anything — see lib/services/model-lab.ts.
  { href: "/model-lab", label: "Model Lab",  icon: FlaskConical,    exact: false, managerOnly: true,  group: "workspace" },
  // Managers only: provider keys and what each one has spent.
  { href: "/credits",   label: "Credits",    icon: Coins,           exact: false, managerOnly: true,  group: "workspace" },
  { href: "/settings",  label: "Settings",   icon: Settings,        exact: false, managerOnly: false, group: "workspace" },
] as const;

const NAV_GROUPS = [
  { id: "main",      label: null },
  { id: "records",   label: "Records" },
  { id: "workspace", label: "Workspace" },
] as const;

// Code for the drawers/modals the shell can open. Fetched once the browser is
// idle so the first click on a lead, org or "Add leads" opens on the spot
// instead of waiting for its chunk.
function preloadDrawers() {
  void import("@/components/app/lead-drawer");
  void import("@/components/app/org-drawer");
  void import("@/components/app/add-leads-drawer");
  void import("@/components/app/create-campaign-modal");
}

function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    session, loadingSession, role, leads, setLeads, leadsTotal, leadsByIds, campaigns, loadCampaigns, setCampaigns, loadLeads,
    checkedIds, setCheckedIds, selectedLead, setSelectedLead, selectedOrgId, setSelectedOrgId,
    showAddLeads, setShowAddLeads, manualPrefill, setManualPrefill,
    showCreateCampaign, setShowCreateCampaign, deletingLead, setDeletingLead,
    deleteLeadLoading, setDeleteLeadLoading,
  } = useApp();

  const visibleNavItems = NAV_ITEMS.filter((item) => !item.managerOnly || role === "manager");

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uniboxUnread, setUniboxUnread] = useState<number | null>(null);
  const [apolloCredits, setApolloCredits] = useState<{ remaining: number | null; limit: number | null } | null>(null);
  // Set on a sidebar click, cleared when the route changes: drives the
  // optimistic highlight and the thin progress bar. The current screen stays
  // on screen until the next one is ready (or its loading.tsx shows) —
  // no blank skeleton swap.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  // Starts false on both server and client's first render to avoid a
  // hydration mismatch, then syncs from the persisted value after mount.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") setSidebarCollapsed(true);
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  useEffect(() => { setPendingHref(null); }, [pathname]);

  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(preloadDrawers);
    else setTimeout(preloadDrawers, 1500);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Quick actions searches the leads already in memory. Opening it from a
  // screen that never loaded them (Settings, a hard reload) pulls the first
  // page quietly so a typed name still finds the lead.
  useEffect(() => {
    if (commandOpen && session && leads.length === 0) void loadLeads(session.access_token, { background: true });
  }, [commandOpen, session, leads.length, loadLeads]);

  const commandGroups = useMemo<CommandGroup[]>(() => [
    {
      label: "Go to",
      items: visibleNavItems.map(({ href, label, icon: Icon }) => ({
        id: href,
        label,
        icon: <Icon />,
        onSelect: () => router.push(href),
      })),
    },
    {
      label: "Leads",
      searchOnly: true,
      items: leads.map((l) => ({
        id: l.id,
        label: `${l.firstName} ${l.lastName}`.trim() || l.email || "Lead",
        icon: <User />,
        hint: l.company || undefined,
        keywords: `${l.email} ${l.company} ${l.domain}`,
        onSelect: () => setSelectedLead(l),
      })),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [leads, role, router, setSelectedLead]);

  useEffect(() => {
    if (!loadingSession && !session) router.replace("/");
  }, [loadingSession, session, router]);

  useEffect(() => {
    if (!session) return;
    fetchLogo(session.access_token).then((r) => setLogoUrl(r.logo_url)).catch(() => setLogoUrl(null));
  }, [session]);

  // `session` keeps a stable identity across auth events (see app-context), so
  // the fetch above runs once per full page load — and the shell is a layout
  // that survives client-side nav. Uploading a new logo in Settings therefore
  // left this sidebar showing the old one until a hard refresh, which is what
  // "the logo change doesn't work" actually was. Settings tells us directly.
  useEffect(() => {
    const onLogoChange = (e: Event) => setLogoUrl((e as CustomEvent<string | null>).detail);
    window.addEventListener(BRAND_LOGO_CHANGED, onLogoChange);
    return () => window.removeEventListener(BRAND_LOGO_CHANGED, onLogoChange);
  }, []);

  useEffect(() => {
    if (!session) return;
    const load = () => {
      fetchUniboxUnread(session.access_token).then((r) => setUniboxUnread(r.unread)).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [session]);

  // Scored companies waiting for a manager's Approve / Decline (Leads > Organization).
  const [scoredToReview, setScoredToReview] = useState(0);
  useEffect(() => {
    if (!session || role !== "manager") return;
    const load = () => {
      fetch("/api/v1/prospects?summary=1", { headers: { Authorization: `Bearer ${session.access_token}` } })
        .then((r) => r.json()).then((j) => setScoredToReview(j?.data?.review_total ?? 0)).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [session, role]);

  useEffect(() => {
    if (!session) return;
    const load = () => {
      fetchApolloCredits(session.access_token)
        .then(setApolloCredits)
        .catch(() => setApolloCredits(null));
    };
    load();
    // Cached server-side for 5 minutes — refresh a bit more often than that.
    const id = setInterval(load, 3 * 60_000);
    return () => clearInterval(id);
  }, [session]);

  if (loadingSession) {
    return (
      <div className="h-screen flex bg-background overflow-hidden">
        <aside className="w-60 shrink-0 border-r border-border flex flex-col bg-sidebar animate-pulse">
          <div className="h-12 px-3 flex items-center gap-2">
            <div className="size-6 bg-secondary rounded-md" />
            <div className="h-3.5 w-20 bg-secondary rounded" />
          </div>
          <div className="mx-2 h-8 bg-secondary rounded-md" />
          <nav className="flex-1 p-2 space-y-1 mt-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-8 bg-hover rounded-md" />
            ))}
          </nav>
        </aside>
        <main className="flex-1" />
      </div>
    );
  }

  if (!session) return null;

  // Among items whose href matches the current path, only the most specific
  // (longest href) one should highlight — guards against nested routes matching
  // more than one top-level nav item at once.
  const bestMatchHref = visibleNavItems
    .filter(({ href, exact }) => (exact ? pathname === href : pathname.startsWith(href)))
    .reduce<string | null>((best, item) => (best === null || item.href.length > best.length ? item.href : best), null);

  function isActive(href: string, exact: boolean) {
    if (exact) return pathname === href;
    return href === bestMatchHref;
  }

  const navigating = pendingHref !== null && pendingHref !== pathname;

  // While a click is in flight the clicked item highlights at once, so the
  // sidebar answers instantly even before the route has rendered.
  function isHighlighted(href: string, exact: boolean) {
    return navigating ? href === pendingHref : isActive(href, exact);
  }

  const navBadge = (label: string) =>
    label === "Leads" ? leadsTotal : label === "Campaigns" ? campaigns.length : label === "Unibox" ? uniboxUnread : null;

  return (
    <>
      <div className="h-screen flex bg-background overflow-hidden">
        <aside
          className={cn(
            "shrink-0 border-r border-border flex flex-col bg-sidebar transition-[width] duration-150",
            sidebarCollapsed ? "w-14" : "w-60",
          )}
        >
          {/* Workspace row */}
          <div className={cn("h-12 shrink-0 flex items-center", sidebarCollapsed ? "justify-center px-2" : "gap-2 px-3")}>
            {!sidebarCollapsed && (
              <>
                {logoUrl ? (
                  <img src={logoUrl} alt="Brand logo" className="size-6 rounded-md border border-border bg-field object-contain shrink-0" />
                ) : (
                  <div className="size-6 bg-foreground rounded-md flex items-center justify-center shrink-0">
                    <span className="text-background text-xs font-bold">{APP_LOGO_INITIAL}</span>
                  </div>
                )}
                <span className="text-[13px] font-semibold truncate flex-1">{APP_NAME}</span>
              </>
            )}
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="shrink-0 size-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground transition-colors"
            >
              <PanelLeft className="size-4" />
            </button>
          </div>

          {/* Quick actions (⌘K) */}
          <div className={cn("shrink-0", sidebarCollapsed ? "px-2" : "px-2.5")}>
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              title={sidebarCollapsed ? "Quick actions (⌘K)" : undefined}
              className={cn(
                "w-full h-8 flex items-center rounded-md border border-border bg-field text-[13px] text-muted-foreground shadow-xs hover:text-foreground transition-colors",
                sidebarCollapsed ? "justify-center" : "gap-2 px-2",
              )}
            >
              <Search className="size-3.5 shrink-0" />
              {!sidebarCollapsed && (
                <>
                  <span className="flex-1 text-left">Quick actions</span>
                  <kbd className="text-[11px] font-medium text-muted-foreground/80">⌘K</kbd>
                </>
              )}
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 pb-2">
            {NAV_GROUPS.map((group) => {
              const items = visibleNavItems.filter((i) => i.group === group.id);
              if (items.length === 0) return null;
              return (
                <div key={group.id} className={group.label ? "pt-4" : "pt-3"}>
                  {group.label && !sidebarCollapsed && (
                    <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
                  )}
                  {group.label && sidebarCollapsed && <div className="mx-2 mb-2 h-px bg-border" />}
                  <div className="space-y-px">
                    {items.map(({ href, label, icon: Icon, exact }) => {
                      const active = isHighlighted(href, exact);
                      const badge = navBadge(label);
                      return (
                        <Link
                          key={href}
                          href={href}
                          prefetch
                          title={sidebarCollapsed ? label : undefined}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                            if (!isActive(href, exact)) setPendingHref(href);
                          }}
                          className={cn(
                            "w-full h-8 flex items-center rounded-md text-[13px] font-medium transition-colors relative",
                            sidebarCollapsed ? "justify-center" : "gap-2 px-2",
                            active
                              ? "bg-accent text-foreground"
                              : "text-foreground/75 hover:bg-hover hover:text-foreground",
                          )}
                        >
                          <Icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
                          {!sidebarCollapsed && <span className="flex-1 truncate text-left">{label}</span>}
                          {label === "Leads" && scoredToReview > 0 && !sidebarCollapsed && (
                            <span title={`${scoredToReview} scored companies need your review`} className="inline-flex shrink-0 items-center whitespace-nowrap text-[11px] font-medium rounded-[4px] px-1.5 py-px tabular-nums bg-amber-500/15 text-amber-700 dark:text-amber-400">
                              {scoredToReview} to review
                            </span>
                          )}
                          {badge !== null && badge > 0 && (
                            sidebarCollapsed ? (
                              <span className="absolute top-1.5 right-2 size-1.5 rounded-full bg-primary" />
                            ) : (
                              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                                {badge}
                              </span>
                            )
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          <div className={cn("shrink-0 border-t border-border", sidebarCollapsed ? "p-2 flex flex-col items-center gap-2" : "p-2.5 space-y-1.5")}>
            {apolloCredits?.remaining != null && (() => {
              const { remaining, limit } = apolloCredits;
              // Same "consumed" progress-bar treatment as the Apollo credit
              // pools on the usage page (see CreditPoolRow), so the sidebar
              // readout matches the rest of the app rather than being plain text.
              const consumed = limit != null ? Math.max(0, limit - remaining) : null;
              const pct = limit != null && limit > 0 ? Math.min(100, Math.round((consumed! / limit) * 100)) : null;
              const barColor = pct == null ? "bg-primary" : pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-amber-400" : "bg-primary";
              const titleText = limit != null
                ? `Apollo key credits: ${remaining.toLocaleString()} / ${limit.toLocaleString()} left`
                : `Apollo key credits: ${remaining.toLocaleString()} left`;

              return (
                <div title={titleText} className={cn(sidebarCollapsed ? "w-full space-y-1" : "space-y-1.5 px-2 pb-1")}>
                  <div
                    className={cn(
                      "text-muted-foreground",
                      sidebarCollapsed
                        ? "text-[9px] tabular-nums text-center leading-tight"
                        : "flex items-baseline justify-between gap-2 text-xs",
                    )}
                  >
                    {!sidebarCollapsed && <span className="shrink-0">Apollo credits</span>}
                    <span className="tabular-nums">
                      {limit != null ? `${remaining.toLocaleString()}/${limit.toLocaleString()}` : remaining.toLocaleString()}
                    </span>
                  </div>
                  {pct != null && (
                    <div className={cn("h-1 rounded-full bg-secondary overflow-hidden", sidebarCollapsed ? "w-8 mx-auto" : "w-full")}>
                      <div className={cn("h-full rounded-full transition-[width]", barColor)} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })()}

            {/* External Google Form — a plain `<a target="_blank">`, not next/link,
                since this leaves the app entirely rather than routing within it. */}
            <a
              href={BUG_REPORT_FORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={sidebarCollapsed ? "Report an issue" : undefined}
              className={cn(
                "flex items-center rounded-md text-foreground/75 hover:bg-hover hover:text-foreground transition-colors",
                sidebarCollapsed ? "size-8 justify-center" : "h-8 gap-2 px-2 text-[13px] font-medium",
              )}
            >
              <Bug className="size-4 shrink-0 text-muted-foreground" />
              {!sidebarCollapsed && <span>Report an issue</span>}
            </a>

            <div
              className={cn("flex items-center", sidebarCollapsed ? "justify-center" : "h-8 gap-2 px-2")}
              title={session.user.email}
            >
              <div className="size-5 rounded-full bg-secondary border border-border flex items-center justify-center text-[10px] leading-none font-semibold text-muted-foreground shrink-0">
                {session.user.email?.[0]?.toUpperCase() ?? "?"}
              </div>
              {!sidebarCollapsed && <span className="text-[13px] text-foreground/75 truncate">{session.user.email}</span>}
            </div>
          </div>
        </aside>

        <main className="relative flex-1 overflow-y-auto">
          {navigating && <div className="route-progress" aria-hidden />}
          {children}
        </main>
      </div>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} groups={commandGroups} />

      <ConfirmDialog
        open={!!deletingLead}
        title={`Delete ${deletingLead ? `${deletingLead.firstName} ${deletingLead.lastName}`.trim() : "lead"}?`}
        description="This will permanently remove the lead and all associated data. This cannot be undone."
        loading={deleteLeadLoading}
        onClose={() => { if (!deleteLeadLoading) setDeletingLead(null); }}
        onConfirm={async () => {
          if (!deletingLead || !session) return;
          setDeleteLeadLoading(true);
          try {
            await deleteLead(session.access_token, deletingLead.id);
            setLeads((prev) => prev.filter((l) => l.id !== deletingLead.id));
            setDeletingLead(null);
          } finally {
            setDeleteLeadLoading(false);
          }
        }}
      />

      <CreateCampaignModal
        open={showCreateCampaign}
        onClose={() => { setShowCreateCampaign(false); setCheckedIds(new Set()); }}
        onCreated={(c) => {
          setCampaigns((p) => [c, ...p]);
          setShowCreateCampaign(false);
          setCheckedIds(new Set());
          router.push(`/campaigns/${c.id}`);
        }}
        leads={leadsByIds(checkedIds).filter(isCampaignEligible)}
      />

      <AddLeadsDrawer
        open={showAddLeads}
        onClose={() => { setShowAddLeads(false); setManualPrefill(null); }}
        onImport={() => {
          if (!session) return;
          void loadCampaigns(session.access_token);
          void loadLeads(session.access_token);
        }}
        defaultTab={manualPrefill ? "manual" : "apollo"}
        prefillOrg={manualPrefill?.prefillOrg}
        prefillLeads={manualPrefill?.prefillLeads}
        editMode={manualPrefill?.editMode}
      />

      <LeadDrawer
        lead={selectedLead}
        onClose={() => setSelectedLead(null)}
        onLeadUpdated={(updated) => {
          setLeads((prev) => prev.map((l) => l.id === updated.id ? updated : l));
          // Only refresh the open drawer — never reopen after the user closed it
          // (in-flight fetchFresh would otherwise race and set selectedLead again).
          setSelectedLead((prev) => (prev?.id === updated.id ? updated : prev));
        }}
        onOrgClick={(id) => setSelectedOrgId(id)}
      />

      <OrgDrawer
        orgId={selectedOrgId}
        onClose={() => setSelectedOrgId(null)}
        onLeadClick={(leadId) => {
          const found = leads.find((l) => l.id === leadId);
          if (found) {
            setSelectedOrgId(null);
            setSelectedLead(found);
          } else {
            setSelectedOrgId(null);
            setSelectedLead({ id: leadId, firstName: "", lastName: "", email: "", company: "", domain: "", domainSource: null, phone: "", jobTitle: "", country: "", status: "Enriched", score: "—", source: "Apollo", campaign: "", campaigns: [], createdAt: new Date().toISOString(), orgId: null, enrichmentStage: null, companyDescription: null, sellsTo: null, lastError: null, hasScraped: false, importId: null, batchLabel: null, batchColor: null, assignedTo: null, orgShared: null } satisfies Lead);
          }
        }}
        onAddLead={role === "manager" ? (org) => {
          setSelectedOrgId(null);
          setSelectedLead(null);
          setManualPrefill({
            prefillOrg: { id: org.id, name: org.name, industry: org.industry, domain: org.domain, country: org.country },
            prefillLeads: org.leads,
            editMode: true,
          });
          setShowAddLeads(true);
        } : undefined}
      />
    </>
  );
}

export function ThemedAppShell({ children }: { children: React.ReactNode }) {
  const { session } = useApp();
  return (
    <ThemeProvider session={session}>
      <AppShell>{children}</AppShell>
    </ThemeProvider>
  );
}
