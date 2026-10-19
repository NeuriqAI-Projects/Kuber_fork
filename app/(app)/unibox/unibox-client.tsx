"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  AtSign,
  Briefcase,
  Building2,
  Clock,
  ExternalLink,
  Inbox,
  Loader2,
  Mail,
  Megaphone,
  MessagesSquare,
  RefreshCw,
  Thermometer,
  User,
  UserRound,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import {
  cacheKeys,
  queryCache,
  fetchUniboxThread,
  fetchUniboxThreads,
  markThreadRead,
  prefetchCampaign,
  prefetchLead,
  setThreadStatus,
  syncUnibox,
  type ReplyDraft,
  type UniboxMessage,
  type UniboxThreadSummary,
} from "@/lib/api-client";
import { pickLatestDraftForThread } from "@/lib/reply-draft-pick";
import { UniboxThreadList } from "@/components/app/unibox/unibox-thread-list";
import { UniboxThreadView } from "@/components/app/unibox/unibox-thread-view";
import { UniboxTemperatureBadge } from "@/components/app/unibox/unibox-temperature-badge";
import { UniboxInstantlyInterestMenu } from "@/components/app/unibox/unibox-instantly-interest-menu";
import type { UniboxInterestFilter, UniboxReadStateFilter } from "@/components/app/unibox/unibox-status-filter";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DetailRow, DetailSection } from "@/components/ui/record-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const READ_STATE_VALUES: UniboxReadStateFilter[] = ["all", "unread", "read", "replied", "needs_reply", "no_reply"];

function parseReadStateParam(v: string | null): UniboxReadStateFilter {
  return v && (READ_STATE_VALUES as string[]).includes(v) ? (v as UniboxReadStateFilter) : "all";
}

function parseInterestParam(v: string | null): UniboxInterestFilter {
  if (!v) return "all";
  if (v === "lead") return "lead";
  const n = Number(v);
  return Number.isFinite(n) ? n : "all";
}

function parseCampaignIdsParam(sp: URLSearchParams): string[] {
  const ids = sp.get("campaign_ids");
  if (ids) return ids.split(",").map((s) => s.trim()).filter(Boolean);
  const single = sp.get("campaign_id");
  return single ? [single] : [];
}

// Latest reply_draft for the latest inbound message, regardless of status —
// used as the anchor id for regenerating a fresh draft (even after one was
// already sent), and to know whether one is ready to show.
function pickLatestDraft(messages: UniboxMessage[], drafts: ReplyDraft[]): ReplyDraft | null {
  const received = messages.filter((m) => m.direction === "received");
  const latest = received[received.length - 1];
  return pickLatestDraftForThread(latest?.reply_event_id, drafts);
}

type ThreadsPage = Awaited<ReturnType<typeof fetchUniboxThreads>>;

function buildThreadParams(f: {
  eaccount: string | null;
  debouncedSearch: string;
  campaignIds: string[];
  readState: UniboxReadStateFilter;
  interest: UniboxInterestFilter;
  cursor: string | null;
}): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {
    eaccount: f.eaccount ?? undefined,
    q: f.debouncedSearch || undefined,
    cursor: f.cursor ?? undefined,
    limit: "30",
  };
  if (f.campaignIds.length > 0) {
    params.campaign_ids = f.campaignIds.join(",");
  }
  if (f.readState !== "all") {
    params.status = f.readState;
  }
  if (f.interest !== "all") {
    params.interest = f.interest === "lead" ? "lead" : String(f.interest);
  }
  return params;
}

function threadsPageKey(params: Record<string, string | undefined>): string {
  return cacheKeys.uniboxThreads(
    new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString(),
  );
}

export function UniboxClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Seeded from the app session so the first request doesn't wait on a
  // separate getSession round trip; the effect below keeps the old behaviour.
  const { session, campaigns: allCampaigns } = useApp();
  const [token, setToken] = useState(() => session?.access_token ?? "");
  const [campaignIds, setCampaignIds] = useState<string[]>(() => parseCampaignIdsParam(searchParams));
  const [eaccount, setEaccount] = useState<string | null>(() => searchParams.get("eaccount"));
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");
  const [readState, setReadState] = useState<UniboxReadStateFilter>(() => parseReadStateParam(searchParams.get("status")));
  const [interest, setInterest] = useState<UniboxInterestFilter>(() => parseInterestParam(searchParams.get("interest")));
  // Seed the list from the cached first page for the filters in the URL, so a
  // revisit paints the threads on the very first frame (no skeleton flash).
  const [initialPage] = useState(() => queryCache.getData<ThreadsPage>(threadsPageKey(buildThreadParams({
    eaccount, debouncedSearch, campaignIds, readState, interest, cursor: null,
  }))));
  const [unreadTotal, setUnreadTotal] = useState(initialPage?.counts.unread_total ?? 0);
  const [threads, setThreads] = useState<UniboxThreadSummary[]>(initialPage?.threads ?? []);
  const [threadsTotal, setThreadsTotal] = useState<number | null>(initialPage?.counts.total ?? null);
  const [cursor, setCursor] = useState<string | null>(initialPage?.next_cursor ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinnedSummary, setPinnedSummary] = useState<UniboxThreadSummary | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(!initialPage);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // The campaign filter reads the shared (cached) campaigns list instead of
  // fetching its own copy on every visit.
  const campaigns = useMemo(
    () => allCampaigns.map((x) => ({ id: x.id, name: x.name })),
    [allCampaigns],
  );
  const [threadDetail, setThreadDetail] = useState<Awaited<ReturnType<typeof fetchUniboxThread>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slower, older request (e.g. the initial unfiltered load)
  // resolving after a newer filtered one and silently overwriting the list
  // with stale results — the list would then disagree with the highlighted
  // filter, making filters look broken.
  const loadThreadsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setToken(data.session.access_token);
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Keep filters in the URL so a refresh (or sharing the link) restores them
  // instead of silently resetting to "All".
  useEffect(() => {
    const qs = new URLSearchParams();
    if (campaignIds.length > 0) qs.set("campaign_ids", campaignIds.join(","));
    if (eaccount) qs.set("eaccount", eaccount);
    if (readState !== "all") qs.set("status", readState);
    if (interest !== "all") qs.set("interest", String(interest));
    if (debouncedSearch) qs.set("q", debouncedSearch);
    const qsStr = qs.toString();
    router.replace(qsStr ? `${pathname}?${qsStr}` : pathname, { scroll: false });
  }, [campaignIds, eaccount, readState, interest, debouncedSearch, pathname, router]);

  const eaccounts = useMemo(
    () => [...new Set(threads.map((t) => t.eaccount).filter(Boolean))] as string[],
    [threads],
  );

  const loadThreads = useCallback(async (append = false) => {
    if (!token) return;
    // Cancel any request still in flight (e.g. from a filter clicked a moment
    // ago) so its response can never land after — and overwrite — this one.
    loadThreadsAbortRef.current?.abort();
    const controller = new AbortController();
    loadThreadsAbortRef.current = controller;
    const params = buildThreadParams({ eaccount, debouncedSearch, campaignIds, readState, interest, cursor: append ? cursor : null });

    // First page per filter set is cached: revisiting Unibox (or flipping back
    // to a filter seen before) shows that list at once and refreshes it quietly.
    const pageKey = threadsPageKey(params);
    const cachedPage = append ? undefined : queryCache.getData<ThreadsPage>(pageKey);
    if (append) setLoadingMore(true);
    else if (cachedPage) {
      setThreads(cachedPage.threads);
      setCursor(cachedPage.next_cursor);
      setThreadsTotal(cachedPage.counts.total);
      setUnreadTotal(cachedPage.counts.unread_total);
      setLoading(false);
    } else {
      setLoading(true);
      // Clear the old list right away on a fresh (non-append) load so a filter
      // change never shows the previous filter's results while the new request
      // is in flight — it should read as "cleared, then repopulated", not
      // "stale list that suddenly swaps out".
      setThreads([]);
      setCursor(null);
      setThreadsTotal(null);
    }
    try {
      const data = await fetchUniboxThreads(token, params, controller.signal);
      if (controller.signal.aborted) return;
      if (!append) queryCache.set(pageKey, data);
      setThreads((prev) => (append ? [...prev, ...data.threads] : data.threads));
      setCursor(data.next_cursor);
      setThreadsTotal(data.counts.total);
      if (!append) setUnreadTotal(data.counts.unread_total);
    } catch (e) {
      if (controller.signal.aborted || (e as Error).name === "AbortError") return;
      toast.error((e as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [token, campaignIds, eaccount, debouncedSearch, readState, interest, cursor]);

  useEffect(() => { void loadThreads(false); }, [token, campaignIds, eaccount, debouncedSearch, readState, interest]);

  const loadDetail = useCallback(async (threadId: string, opts?: { silent?: boolean }) => {
    if (!token) return;
    // A thread opened before renders from cache right away; the fetch below
    // still refreshes it (and marks it read) as before.
    const cachedDetail = queryCache.getData<Awaited<ReturnType<typeof fetchUniboxThread>>>(cacheKeys.uniboxThread(threadId));
    if (cachedDetail) setThreadDetail(cachedDetail);
    if (!opts?.silent && !cachedDetail) setDetailLoading(true);
    try {
      const detail = await fetchUniboxThread(token, threadId, true);
      queryCache.set(cacheKeys.uniboxThread(threadId), detail);
      setThreadDetail(detail);
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        void markThreadRead(token, threadId).catch(() => {});
      }, 1000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      if (!opts?.silent) setDetailLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function handleSync() {
    if (!token) return;
    setSyncing(true);
    try {
      const r = await syncUnibox(token);
      toast.success(
        r.failed > 0
          ? `Synced ${r.ingested} emails (${r.pages} pages) — ${r.failed} could not be read`
          : `Synced ${r.ingested} emails (${r.pages} pages)`,
      );
      await loadThreads(false);
      if (selectedId) await loadDetail(selectedId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  // Only the selected thread's own detail is ever rendered. Right after a click
  // the previous thread's detail is still in state (and a cached revisit skips
  // the loading flag), so without this check the view would mount with the
  // wrong — or no — messages and never expand the newest one.
  const detail = threadDetail?.thread_id === selectedId ? threadDetail : null;

  // The open thread stays open even when a filter change or refresh drops it
  // from the list — the list is the newest copy when it has one.
  const selectedSummary = threads.find((t) => t.thread_id === selectedId)
    ?? (pinnedSummary?.thread_id === selectedId ? pinnedSummary : undefined);
  const leadName = selectedSummary
    ? [selectedSummary.lead?.first_name, selectedSummary.lead?.last_name].filter(Boolean).join(" ") || selectedSummary.lead_email || "Unknown"
    : "";

  const latestDraft = useMemo(
    () => pickLatestDraft(detail?.messages ?? [], detail?.reply_drafts ?? []),
    [detail],
  );

  const leadTemperature = detail?.lead_temperature ?? selectedSummary?.lead_temperature ?? null;
  // Below lg the panes stack: the list, or the open thread with a back button.
  const showDetail = view === "detail" && !!selectedSummary;
  // A deleted lead's thread stays fully functional by design (planning.md
  // §3.6/§5.6) — history and reply rights are unaffected — but the viewer
  // should know the underlying lead record no longer exists.
  const leadRecord = detail?.lead as { id?: string; title?: string | null; is_deleted?: boolean } | null | undefined;
  const leadIsDeleted = !!leadRecord?.is_deleted;
  const threadSubject =
    detail?.messages?.find((m) => m.subject)?.subject ?? selectedSummary?.subject ?? "(no subject)";

  function handleInterestChange(v: number | null) {
    if (!token || !selectedId || !selectedSummary) return;
    void setThreadStatus(token, selectedId, v, selectedSummary.lead_email ?? undefined)
      .then(() => { void loadThreads(false); void loadDetail(selectedId, { silent: true }); })
      .catch((e) => toast.error((e as Error).message));
  }

  const interestStatus = detail?.interest_status ?? selectedSummary?.interest_status ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Unibox"
        icon={<Inbox />}
        description={unreadTotal > 0 ? `${unreadTotal} unread` : undefined}
        actions={
          <Button type="button" variant="outline" onClick={() => void handleSync()} disabled={syncing}>
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Sync now
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: thread list */}
        <aside
          className={cn(
            "min-h-0 w-full shrink-0 flex-col border-border bg-card lg:flex lg:w-[360px] lg:border-r",
            showDetail ? "hidden" : "flex",
          )}
        >
          <UniboxThreadList
            threads={threads}
            threadsTotal={threadsTotal}
            selectedId={selectedId}
            search={search}
            loading={loading}
            loadingMore={loadingMore}
            readState={readState}
            interest={interest}
            unreadTotal={unreadTotal}
            campaignIds={campaignIds}
            campaigns={campaigns}
            eaccount={eaccount}
            eaccounts={eaccounts}
            onCampaigns={setCampaignIds}
            onEaccount={setEaccount}
            onReadState={setReadState}
            onInterest={setInterest}
            onSearch={setSearch}
            onSelect={(id) => {
              setPinnedSummary(threads.find((t) => t.thread_id === id) ?? null);
              setSelectedId(id);
              setView("detail");
            }}
            hasMore={!!cursor}
            onLoadMore={() => void loadThreads(true)}
          />
        </aside>

        {/* Middle: open thread */}
        <main className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", showDetail ? "flex" : "hidden")}>
          {selectedSummary ? (
            <>
              <div className="flex shrink-0 items-start gap-3 border-b border-border px-6 py-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setView("list")}
                  aria-label="Back to conversations"
                  className="-ml-2 mt-0.5 shrink-0 text-muted-foreground lg:hidden"
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[15px] font-semibold leading-snug text-foreground" title={threadSubject}>
                    {threadSubject}
                  </h2>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span className="truncate font-medium text-foreground">{leadName}</span>
                    {selectedSummary.lead_email && selectedSummary.lead_email !== leadName && (
                      <span className="truncate">{selectedSummary.lead_email}</span>
                    )}
                    {leadIsDeleted && (
                      <Badge
                        variant="secondary"
                        title="This lead's record has been deleted. Thread history and reply rights are unaffected."
                        className="shrink-0"
                      >
                        Lead deleted
                      </Badge>
                    )}
                    {selectedSummary.campaign && (
                      <>
                        <span className="shrink-0 text-muted-foreground/50">·</span>
                        <Link
                          href={`/campaigns/${selectedSummary.campaign.id}`}
                          onMouseEnter={() => prefetchCampaign(selectedSummary.campaign!.id)}
                          className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline"
                        >
                          <span className="truncate">{selectedSummary.campaign.name}</span>
                          <ExternalLink className="size-3 shrink-0 opacity-70" />
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                {/* The Details rail carries these from xl up. */}
                <div className="flex shrink-0 items-center gap-2 xl:hidden">
                  <UniboxTemperatureBadge temperature={leadTemperature} />
                  <UniboxInstantlyInterestMenu interestStatus={interestStatus} onChange={handleInterestChange} />
                </div>
              </div>
              {detailLoading || !detail ? (
                <div className="min-h-0 flex-1 space-y-3 px-6 py-5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
                      <Skeleton className="size-7 rounded-full shrink-0" />
                      <Skeleton className="h-3.5 w-28 shrink-0" />
                      <Skeleton className="h-3 flex-1" />
                      <Skeleton className="h-3 w-12 shrink-0" />
                    </div>
                  ))}
                </div>
              ) : (
                <UniboxThreadView
                  key={selectedId}
                  messages={detail?.messages ?? []}
                  leadName={leadName}
                  leadEmail={selectedSummary.lead_email}
                  campaign={selectedSummary.campaign}
                  threadId={selectedId!}
                  token={token}
                  canReply={!!detail?.reply_to_uuid}
                  latestDraft={latestDraft}
                  // Prefer what they wrote, but fall back to ANY message with a
                  // subject. A thread where the lead has never replied has no
                  // received message at all, and seeding null there left the
                  // Subject box empty and the Send button silently dead —
                  // exactly the case where you most want to chase them.
                  replyToSubject={
                    detail?.messages?.find((m) => m.direction === "received" && m.subject)?.subject
                    ?? detail?.messages?.find((m) => m.subject)?.subject
                    ?? null
                  }
                  // Our mailbox on this thread — keeps it out of the CC list we
                  // build from the thread's participants.
                  eaccount={detail?.eaccount ?? null}
                  knownLeadEmails={detail?.known_lead_emails ?? []}
                  organizationName={detail?.lead_organization_name ?? null}
                  ownerName={detail?.lead_owner_name ?? null}
                  onChanged={() => { void loadThreads(false); void loadDetail(selectedId!, { silent: true }); }}
                />
              )}
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6">
              <EmptyState
                boxed={false}
                icon={Mail}
                title="No conversation selected"
                message="Pick a thread on the left to read it and reply."
              />
            </div>
          )}
        </main>

        {/* Right: Details rail (xl and up) */}
        {selectedSummary && (
          <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-border bg-card xl:block">
            <DetailSection title="Lead">
              <DetailRow icon={<User />} label="Name">
                {leadRecord?.id && !leadIsDeleted ? (
                  <Link
                    href={`/leads/${leadRecord.id}`}
                    onMouseEnter={() => prefetchLead(leadRecord.id!)}
                    className="flex min-w-0 items-center gap-1.5 hover:underline"
                  >
                    <Avatar name={leadName} size="sm" />
                    <span className="truncate">{leadName}</span>
                  </Link>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={leadName} size="sm" />
                    <span className="truncate">{leadName}</span>
                  </span>
                )}
              </DetailRow>
              <DetailRow icon={<AtSign />} label="Email">
                <span title={selectedSummary.lead_email ?? undefined}>{selectedSummary.lead_email ?? "—"}</span>
              </DetailRow>
              {(leadRecord?.title ?? selectedSummary.lead?.title) && (
                <DetailRow icon={<Briefcase />} label="Title">
                  {leadRecord?.title ?? selectedSummary.lead?.title}
                </DetailRow>
              )}
              <DetailRow icon={<Building2 />} label="Company">
                {detail?.lead_organization_name ?? <span className="text-muted-foreground">—</span>}
              </DetailRow>
              <DetailRow icon={<UserRound />} label="Owner">
                {detail?.lead_owner_name ?? <span className="text-muted-foreground">Unassigned</span>}
              </DetailRow>
            </DetailSection>
            <DetailSection title="Conversation">
              <DetailRow icon={<Thermometer />} label="Temperature">
                <UniboxTemperatureBadge temperature={leadTemperature} />
              </DetailRow>
              <DetailRow icon={<Zap />} label="Instantly status">
                <UniboxInstantlyInterestMenu variant="inline" interestStatus={interestStatus} onChange={handleInterestChange} />
              </DetailRow>
              <DetailRow icon={<Megaphone />} label="Campaign">
                {selectedSummary.campaign ? (
                  <Link
                    href={`/campaigns/${selectedSummary.campaign.id}`}
                    onMouseEnter={() => prefetchCampaign(selectedSummary.campaign!.id)}
                    className="text-primary hover:underline"
                  >
                    {selectedSummary.campaign.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DetailRow>
              <DetailRow icon={<Inbox />} label="Inbox">
                <span title={detail?.eaccount ?? selectedSummary.eaccount ?? undefined}>
                  {detail?.eaccount ?? selectedSummary.eaccount ?? "—"}
                </span>
              </DetailRow>
              <DetailRow icon={<MessagesSquare />} label="Messages">
                <span className="tabular-nums">{detail?.messages?.length ?? selectedSummary.message_count}</span>
              </DetailRow>
              <DetailRow icon={<Clock />} label="Last activity">
                <span className="tabular-nums">{format(new Date(selectedSummary.latest_at), "MMM d, h:mm a")}</span>
              </DetailRow>
            </DetailSection>
          </aside>
        )}
      </div>
    </div>
  );
}
