"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-context";
import {
  deleteCampaign, pauseCampaign, resumeCampaign, prefetchCampaign,
  useCached, cacheKeys, cachedFetchers, type Profile,
} from "@/lib/api-client";
import { CampaignsSkeleton } from "@/components/app/page-skeletons";
import type { Campaign } from "@/components/app/create-campaign-modal";
import { Megaphone, Pause, Play, Plus, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { Avatar } from "@/components/leads/lead-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type CampaignStatus = "Draft" | "Live" | "Paused";

// Attio tag pairs: pale fill + dark text in light mode, low-alpha fill + light
// text in dark mode (see root CLAUDE.md "Tags / status pills").
const CAMPAIGN_STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  Draft:     { badge: "bg-secondary text-muted-foreground border-border", dot: "bg-zinc-400" },
  Scheduled: { badge: "bg-blue-100 text-blue-800 border-blue-200/70 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/25", dot: "bg-blue-500" },
  Live:      { badge: "bg-green-100 text-green-800 border-green-200/70 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/25", dot: "bg-green-500" },
  Paused:    { badge: "bg-amber-100 text-amber-800 border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25", dot: "bg-amber-500" },
};

/** createdAt is a yyyy-mm-dd day; show it the way the rest of the app does. */
function formatCreated(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : format(d, "d MMM yyyy");
}

export function CampaignsClient() {
  const router = useRouter();
  // The list is the shared campaigns cache: instant on revisit, refreshed in
  // the background, and updated in place after pause/resume/delete (no
  // router.refresh(), which threw the whole router cache away).
  const { campaigns, setCampaigns, campaignsLoaded, loadCampaigns, session, role } = useApp();
  const list = campaigns;

  // The cached list paints at once; refresh it quietly on every visit, as the
  // old server-rendered page effectively did.
  useEffect(() => {
    if (session) void loadCampaigns(session.access_token);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, []);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | "All">("All");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const usersQuery = useCached<Profile[]>(
    role === "manager" && session ? cacheKeys.users : null,
    cachedFetchers.users,
  );
  const users = usersQuery.data ?? [];
  const [deletingCampaign, setDeletingCampaign] = useState<Campaign | null>(null);
  const [deleteCampaignLoading, setDeleteCampaignLoading] = useState(false);
  const [pausingCampaign, setPausingCampaign] = useState<Campaign | null>(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const userMap = new Map(users.map((u) => [u.id, u]));

  function displayName(userId: string | null | undefined): string | null {
    if (!userId) return null;
    const u = userMap.get(userId);
    return u ? (u.full_name || u.email) : null;
  }

  const filtered = list.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "All" || c.status === statusFilter;
    const matchesOwner = ownerFilter === "all" || c.createdBy === ownerFilter || c.assignedTo === ownerFilter;
    return matchesSearch && matchesStatus && matchesOwner;
  });

  const counts: Record<CampaignStatus | "All", number> = {
    All:    list.length,
    Draft:  list.filter((c) => c.status === "Draft").length,
    Live:   list.filter((c) => c.status === "Live").length,
    Paused: list.filter((c) => c.status === "Paused").length,
  };

  async function handleResume(c: Campaign) {
    if (!session || resumingId) return;
    setResumingId(c.id);
    try {
      const res = await resumeCampaign(session.access_token, c.id);
      if (res.errors.length > 0) {
        toast.warning(`Resumed ${res.resumed} region(s); ${res.errors.length} failed. Try again for the rest.`);
      } else {
        toast.success("Campaign resumed — Instantly is sending again");
      }
      setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: "Live" } : x)));
      void loadCampaigns(session.access_token);
    } catch (e) {
      toast.error((e as Error).message || "Failed to resume campaign");
    } finally {
      setResumingId(null);
    }
  }

  // First visit only — afterwards the cached list renders immediately.
  if (!campaignsLoaded) return <CampaignsSkeleton />;

  const isManager = role === "manager";

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Campaigns"
        icon={<Megaphone />}
        actions={
          // A campaign is created from a lead selection, so this starts there:
          // the Leads screen's "Create campaign" opens the modal with the
          // ticked leads (the modal can't create a campaign with none).
          <Button size="sm" onClick={() => router.push("/leads")} title="Pick leads on the Leads screen, then Create campaign">
            <Plus />
            New campaign
          </Button>
        }
      />

      {/* Drafts are written here, so a dead LLM key has to be visible here. It
          was only on Leads and Dashboard, which is why a whole campaign could
          show "No draft" on every row with no explanation anywhere. The banner
          renders nothing when healthy, so empty:hidden drops the spacing. */}
      <div className="shrink-0 px-4 pt-3 empty:hidden">
        <ServiceHealthBanner />
      </div>

      <Toolbar>
        <SegmentedTabs
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={(["All", "Draft", "Live", "Paused"] as const).map((s) => ({
            value: s, label: s, count: counts[s],
          }))}
        />
        {isManager && users.length > 0 && (
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="Owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search campaigns…"
          size="sm"
          wrapperClassName="ml-auto w-56"
        />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Megaphone}
              title={list.length === 0 ? "No campaigns yet" : "No campaigns found"}
              message={
                list.length === 0
                  ? "Create one from the Leads screen to start sending outreach emails."
                  : "No campaigns match your filters."
              }
            >
              {list.length === 0 && (
                <Button size="sm" onClick={() => router.push("/leads")}>
                  <Plus />
                  New campaign
                </Button>
              )}
            </EmptyState>
          </div>
        ) : (
          <Table className="border-b border-border">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="min-w-[220px]">Campaign</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-28">Mode</TableHead>
                {isManager && <TableHead className="w-44">Owner</TableHead>}
                <TableHead className="w-20 text-right">Leads</TableHead>
                <TableHead className="w-20 text-right">Sent</TableHead>
                <TableHead className="w-20 text-right">Replied</TableHead>
                <TableHead className="w-24 text-right">Reply rate</TableHead>
                <TableHead className="w-28">Created</TableHead>
                <TableHead className="w-[88px]"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => {
                const style = CAMPAIGN_STATUS_STYLES[c.status] ?? CAMPAIGN_STATUS_STYLES.Draft;
                // c.sent deliberately EXCLUDES anyone who has since replied or
                // bounced (see campaignOutcomes) — a narrower "no reply yet"
                // figure, not the delivered total. The row should read the same
                // as the Analytics tab: Sent = delivered (reached an inbox,
                // replies/bounces included), reply rate against that same total.
                const replyRate = c.delivered > 0 ? Math.round((c.replied / c.delivered) * 100) : 0;
                const ownerName = displayName(c.assignedTo) ?? displayName(c.createdBy);
                const open = () => router.push(`/campaigns/${c.id}`);
                return (
                  <TableRow
                    key={c.id}
                    role="link"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => { if (e.key === "Enter") open(); }}
                    onMouseEnter={() => { prefetchCampaign(c.id); router.prefetch(`/campaigns/${c.id}`); }}
                    className="group/row cursor-pointer"
                  >
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("size-2 shrink-0 rounded-full", style.dot)} />
                        <span className="truncate font-medium text-foreground">{c.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Pill shape="sm" className={style.badge}>{c.status}</Pill>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {c.humanInLoop ? "Human review" : "Auto-send"}
                    </TableCell>
                    {isManager && (
                      <TableCell>
                        {ownerName ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <Avatar name={ownerName} size="sm" />
                            <span className="truncate">{ownerName}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{c.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.delivered}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.replied}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", replyRate > 0 ? "text-green-700 dark:text-green-400" : "text-muted-foreground")}>
                      {replyRate}%
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatCreated(c.createdAt)}
                    </TableCell>
                    <TableCell className="py-0" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                        {c.status === "Live" && (
                          <Button
                            type="button" variant="ghost" size="icon-sm"
                            title="Pause campaign (stops all sending, incl. follow-ups)"
                            onClick={() => setPausingCampaign(c)}
                            className="text-muted-foreground hover:text-amber-700 dark:hover:text-amber-400"
                          >
                            <Pause className="size-3.5" />
                          </Button>
                        )}
                        {c.status === "Paused" && (
                          <Button
                            type="button" variant="ghost" size="icon-sm"
                            title="Resume campaign"
                            disabled={resumingId === c.id}
                            onClick={() => void handleResume(c)}
                            className="text-muted-foreground hover:text-green-700 dark:hover:text-green-400"
                          >
                            <Play className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button" variant="ghost" size="icon-sm"
                          title="Delete campaign"
                          onClick={() => setDeletingCampaign(c)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={!!deletingCampaign}
        title={`Delete "${deletingCampaign?.name}"?`}
        description="This will permanently delete the campaign and all its leads, drafts, and send history. This cannot be undone."
        loading={deleteCampaignLoading}
        onClose={() => { if (!deleteCampaignLoading) setDeletingCampaign(null); }}
        onConfirm={async () => {
          if (!deletingCampaign || !session || deleteCampaignLoading) return;
          const id = deletingCampaign.id;
          setDeleteCampaignLoading(true);
          try {
            await deleteCampaign(session.access_token, id);
            setCampaigns((prev) => prev.filter((c) => c.id !== id));
            setDeletingCampaign(null);
            toast.success("Campaign deleted");
            void loadCampaigns(session.access_token);
          } catch (e) {
            toast.error((e as Error).message || "Failed to delete campaign");
          } finally {
            setDeleteCampaignLoading(false);
          }
        }}
      />

      <ConfirmDialog
        open={!!pausingCampaign}
        title={`Pause "${pausingCampaign?.name}"?`}
        description="Instantly stops sending this campaign, including scheduled follow-ups, until you resume it. Conversations already started are unaffected."
        confirmLabel="Pause"
        tone="warning"
        loading={pauseLoading}
        onClose={() => { if (!pauseLoading) setPausingCampaign(null); }}
        onConfirm={async () => {
          if (!pausingCampaign || !session || pauseLoading) return;
          const id = pausingCampaign.id;
          setPauseLoading(true);
          try {
            const res = await pauseCampaign(session.access_token, id);
            if (res.errors.length > 0) {
              toast.warning(`Paused ${res.paused} region(s); ${res.errors.length} failed. Try again for the rest.`);
            } else {
              toast.success("Campaign paused — Instantly has stopped sending");
            }
            setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status: "Paused" } : c)));
            setPausingCampaign(null);
            void loadCampaigns(session.access_token);
          } catch (e) {
            toast.error((e as Error).message || "Failed to pause campaign");
          } finally {
            setPauseLoading(false);
          }
        }}
      />

    </div>
  );
}
