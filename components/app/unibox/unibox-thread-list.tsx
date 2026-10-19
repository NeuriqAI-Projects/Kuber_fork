"use client";

import { format, isThisYear, isToday } from "date-fns";
import { Inbox, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cacheKeys,
  fetchUniboxThread,
  getAccessToken,
  prefetch,
  type UniboxThreadSummary,
} from "@/lib/api-client";
import { temperatureBadge } from "@/lib/temperature-badge";
import type { UniboxInterestFilter, UniboxReadStateFilter } from "@/components/app/unibox/unibox-status-filter";
import {
  hasActiveUniboxFilters,
  UniboxFilterMenu,
  UniboxReadStateSelect,
} from "@/components/app/unibox/unibox-filters";
import { temperatureLabel } from "@/components/app/unibox/unibox-temperature-badge";
import { Avatar } from "@/components/leads/lead-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** Mirrors the real row's layout so the loading state doesn't jump/reflow once data arrives. */
function ThreadRowSkeleton() {
  return (
    <div className="flex gap-3 border-b border-border px-4 py-3">
      <Skeleton className="size-7 rounded-full shrink-0" />
      <div className="flex-1 min-w-0 space-y-2 pt-0.5">
        <div className="flex justify-between gap-3">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

// Hover intent: sweeping the pointer down the list must not fetch every row
// it crosses — only the one it rests on. Prefetch reads the thread without
// ?hydrate (a plain DB read, no Instantly call, does not mark it read); the
// click still runs the normal hydrating load and paints from this cache first.
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function prefetchThread(threadId: string) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    prefetch(cacheKeys.uniboxThread(threadId), async () => fetchUniboxThread(await getAccessToken(), threadId));
  }, 120);
}
function cancelPrefetchThread() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
}

function rowTime(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "h:mm a");
  return isThisYear(d) ? format(d, "MMM d") : format(d, "MMM d, yyyy");
}

type Props = {
  threads: UniboxThreadSummary[];
  threadsTotal: number | null;
  selectedId: string | null;
  search: string;
  loading: boolean;
  loadingMore?: boolean;
  readState: UniboxReadStateFilter;
  interest: UniboxInterestFilter;
  unreadTotal: number;
  campaignIds: string[];
  campaigns: Array<{ id: string; name: string }>;
  eaccount: string | null;
  eaccounts: string[];
  onCampaigns: (ids: string[]) => void;
  onEaccount: (e: string | null) => void;
  onReadState: (v: UniboxReadStateFilter) => void;
  onInterest: (v: UniboxInterestFilter) => void;
  onSearch: (q: string) => void;
  onSelect: (threadId: string) => void;
  onLoadMore?: () => void;
  hasMore: boolean;
  /** "full" = Gmail-style inbox page (one line per email, full width).
   *  "rail" = the narrow two-line list beside an open thread. */
  layout?: "full" | "rail";
};

/** Needs reply / temperature / campaign tags shared by both layouts. */
function ThreadTags({ t, compact }: { t: UniboxThreadSummary; compact?: boolean }) {
  const needsReply = t.latest_direction === "received";
  const temp = t.lead_temperature && t.lead_temperature !== "neutral" ? t.lead_temperature : null;
  if (!t.campaign && !temp && !needsReply) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", !compact && "mt-1.5")}>
      {needsReply && (
        <Badge
          variant="outline"
          className="shrink-0 border-amber-200/70 bg-amber-100 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300"
          title="The latest message is theirs"
        >
          Needs reply
        </Badge>
      )}
      {temp && (
        <Badge variant="outline" className={cn("shrink-0", temperatureBadge(temp).cls)}>
          {temperatureLabel(temp)}
        </Badge>
      )}
      {t.campaign && (
        <Badge variant="secondary" className={cn("min-w-0 justify-start text-muted-foreground", compact && "max-w-[160px]")}>
          <span className="truncate">{t.campaign.name}</span>
        </Badge>
      )}
    </span>
  );
}

function threadName(t: UniboxThreadSummary) {
  return [t.lead?.first_name, t.lead?.last_name].filter(Boolean).join(" ") || t.lead_email || "Unknown";
}

/** Gmail-style row: sender · tags · subject — snippet · time, on one line. */
function InboxRow({ t, onSelect }: { t: UniboxThreadSummary; onSelect: (id: string) => void }) {
  const name = threadName(t);
  const isUnread = t.unread_count > 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(t.thread_id)}
        onMouseEnter={() => prefetchThread(t.thread_id)}
        onMouseLeave={cancelPrefetchThread}
        className={cn(
          "flex h-11 w-full items-center gap-3 border-b border-border px-4 text-left text-[13px] transition-colors hover:bg-hover",
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          {isUnread && <span aria-label="Unread" className="size-2 rounded-full bg-primary" />}
        </span>
        <Avatar name={name} size="xs" />
        <span className={cn("w-44 shrink-0 truncate", isUnread ? "font-semibold text-foreground" : "text-foreground/90")}>
          {name}
          {t.message_count > 1 && <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">{t.message_count}</span>}
        </span>
        <ThreadTags t={t} compact />
        <span className="min-w-0 flex-1 truncate">
          <span className={isUnread ? "font-semibold text-foreground" : "text-foreground/90"}>
            {t.subject ?? "(no subject)"}
          </span>
          {t.preview && <span className="text-muted-foreground"> — {t.preview}</span>}
        </span>
        <span className={cn("w-16 shrink-0 text-right text-xs tabular-nums", isUnread ? "font-semibold text-foreground" : "text-muted-foreground")}>
          {rowTime(t.latest_at)}
        </span>
      </button>
    </li>
  );
}

function InboxRowSkeleton() {
  return (
    <div className="flex h-11 items-center gap-3 border-b border-border px-4">
      <span className="w-3 shrink-0" />
      <Skeleton className="size-5 shrink-0 rounded-full" />
      <Skeleton className="h-3 w-36 shrink-0" />
      <Skeleton className="h-3 flex-1" />
      <Skeleton className="h-3 w-12 shrink-0" />
    </div>
  );
}

export function UniboxThreadList({
  threads, threadsTotal, selectedId, search, loading, loadingMore, readState, interest, unreadTotal,
  campaignIds, campaigns, eaccount, eaccounts, onCampaigns, onEaccount,
  onReadState, onInterest, onSearch, onSelect, onLoadMore, hasMore, layout = "rail",
}: Props) {
  const filtersActive = hasActiveUniboxFilters(campaignIds, eaccount, readState, interest) || !!search.trim();
  const full = layout === "full";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("shrink-0 border-b border-border", full ? "flex items-center gap-2 px-4 py-2" : "space-y-2 px-3 py-2.5")}>
        <SearchInput
          value={search}
          onChange={onSearch}
          placeholder="Search by lead name…"
          wrapperClassName={full ? "w-full max-w-sm" : undefined}
        />
        <div className={cn("flex items-center gap-2", full && "flex-1")}>
          <UniboxReadStateSelect readState={readState} onReadState={onReadState} unreadTotal={unreadTotal} />
          <UniboxFilterMenu
            campaigns={campaigns}
            campaignIds={campaignIds}
            onCampaigns={onCampaigns}
            eaccount={eaccount}
            eaccounts={eaccounts}
            onEaccount={onEaccount}
            readState={readState}
            onReadState={onReadState}
            interest={interest}
            onInterest={onInterest}
          />
          <p className="ml-auto truncate text-xs tabular-nums text-muted-foreground">
            {threadsTotal !== null
              ? `${threadsTotal} thread${threadsTotal === 1 ? "" : "s"}`
              : loading
                ? "…"
                : ""}
          </p>
        </div>
      </div>

      <div data-thread-scroll className="min-h-0 flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          Array.from({ length: full ? 16 : 10 }).map((_, i) => (full ? <InboxRowSkeleton key={i} /> : <ThreadRowSkeleton key={i} />))
        ) : threads.length === 0 ? (
          <EmptyState
            boxed={false}
            icon={filtersActive ? SearchX : Inbox}
            title={filtersActive ? "No matching conversations" : "No conversations yet"}
            message={filtersActive ? "Try another search or clear the filters." : "Replies from your campaigns show up here."}
            className="px-6"
          />
        ) : full ? (
          <ul>
            {threads.map((t) => <InboxRow key={t.thread_id} t={t} onSelect={onSelect} />)}
          </ul>
        ) : (
          <ul>
            {threads.map((t) => {
              const name = threadName(t);
              const isUnread = t.unread_count > 0;
              const selected = selectedId === t.thread_id;
              return (
                <li key={t.thread_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.thread_id)}
                    onMouseEnter={() => prefetchThread(t.thread_id)}
                    onMouseLeave={cancelPrefetchThread}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex w-full gap-3 border-b border-border px-4 py-3 text-left transition-colors",
                      selected ? "bg-accent" : "hover:bg-hover",
                    )}
                  >
                    <Avatar name={name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={cn("min-w-0 flex-1 truncate text-[13px]", isUnread ? "font-semibold text-foreground" : "font-medium text-foreground")}>
                          {name}
                        </span>
                        <span className={cn("shrink-0 text-xs tabular-nums", isUnread ? "font-medium text-foreground" : "text-muted-foreground")}>
                          {rowTime(t.latest_at)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          <span className={isUnread ? "font-medium text-foreground" : "text-foreground/90"}>
                            {t.subject ?? "(no subject)"}
                          </span>
                          {t.preview && <span className="text-muted-foreground"> — {t.preview}</span>}
                        </span>
                        {isUnread ? (
                          t.unread_count > 1 ? (
                            <span className="shrink-0 min-w-[18px] rounded-full bg-primary px-1.5 py-px text-center text-[11px] font-medium tabular-nums text-primary-foreground">
                              {t.unread_count}
                            </span>
                          ) : (
                            <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" />
                          )
                        ) : null}
                      </span>
                      <ThreadTags t={t} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && threadsTotal !== null && (
          <div className="flex justify-center px-4 py-3">
            <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Show more (${threads.length} of ${threadsTotal})`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
