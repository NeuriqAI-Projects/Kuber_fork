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
};

export function UniboxThreadList({
  threads, threadsTotal, selectedId, search, loading, loadingMore, readState, interest, unreadTotal,
  campaignIds, campaigns, eaccount, eaccounts, onCampaigns, onEaccount,
  onReadState, onInterest, onSearch, onSelect, onLoadMore, hasMore,
}: Props) {
  const filtersActive = hasActiveUniboxFilters(campaignIds, eaccount, readState, interest) || !!search.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-2.5">
        <SearchInput value={search} onChange={onSearch} placeholder="Search by lead name…" />
        <div className="flex items-center gap-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          Array.from({ length: 10 }).map((_, i) => <ThreadRowSkeleton key={i} />)
        ) : threads.length === 0 ? (
          <EmptyState
            boxed={false}
            icon={filtersActive ? SearchX : Inbox}
            title={filtersActive ? "No matching conversations" : "No conversations yet"}
            message={filtersActive ? "Try another search or clear the filters." : "Replies from your campaigns show up here."}
            className="px-6"
          />
        ) : (
          <ul>
            {threads.map((t) => {
              const name = [t.lead?.first_name, t.lead?.last_name].filter(Boolean).join(" ") || t.lead_email || "Unknown";
              const needsReply = t.latest_direction === "received";
              const isUnread = t.unread_count > 0;
              const selected = selectedId === t.thread_id;
              const temp = t.lead_temperature && t.lead_temperature !== "neutral" ? t.lead_temperature : null;
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
                      {(t.campaign || temp || needsReply) && (
                        <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
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
                            <Badge variant="secondary" className="min-w-0 justify-start text-muted-foreground">
                              <span className="truncate">{t.campaign.name}</span>
                            </Badge>
                          )}
                        </span>
                      )}
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
