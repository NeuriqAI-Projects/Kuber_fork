"use client";

import { useMemo, useState } from "react";
import { Check, ListFilter } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import {
  INTEREST_FILTER_OPTIONS,
  READ_STATE_OPTIONS,
  type UniboxInterestFilter,
  type UniboxReadStateFilter,
} from "@/components/app/unibox/unibox-status-filter";

const optionClass = (active: boolean) =>
  cn(
    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors hover:bg-hover",
    active && "bg-accent",
  );

/** Whether any filter is currently applied — used for the toggle button's active-dot badge. */
export function hasActiveUniboxFilters(
  campaignIds: string[],
  eaccount: string | null,
  readState: UniboxReadStateFilter,
  interest: UniboxInterestFilter,
): boolean {
  return campaignIds.length > 0 || !!eaccount || readState !== "all" || interest !== "all";
}

/**
 * Read state (mailbox-level: have you read it?) is the everyday filter, so it
 * sits in the list header as its own Select. Read state and Instantly status
 * (CRM-level: is the lead interested?) are independent — a thread can be both
 * Unread AND Interested — so they are chosen separately, never one list.
 */
export function UniboxReadStateSelect({
  readState,
  onReadState,
  unreadTotal,
}: {
  readState: UniboxReadStateFilter;
  onReadState: (v: UniboxReadStateFilter) => void;
  unreadTotal: number;
}) {
  return (
    <Select value={readState} onValueChange={(v) => onReadState(v as UniboxReadStateFilter)}>
      <SelectTrigger className="w-auto min-w-[112px] text-[13px]" aria-label="Conversations">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {READ_STATE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
            {o.value === "unread" && unreadTotal > 0 && (
              <span className="ml-1.5 tabular-nums text-muted-foreground">{unreadTotal}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type FilterTab = "status" | "campaigns" | "inboxes";

/**
 * "Filter" button + popover holding the less common filters (Instantly status,
 * campaigns, inbox accounts). Replaces the old slide-out panel.
 */
export function UniboxFilterMenu({
  campaigns,
  campaignIds,
  onCampaigns,
  eaccount,
  eaccounts,
  onEaccount,
  readState,
  onReadState,
  interest,
  onInterest,
}: {
  campaigns: Array<{ id: string; name: string }>;
  campaignIds: string[];
  onCampaigns: (ids: string[]) => void;
  eaccount: string | null;
  eaccounts: string[];
  onEaccount: (e: string | null) => void;
  readState: UniboxReadStateFilter;
  onReadState: (v: UniboxReadStateFilter) => void;
  interest: UniboxInterestFilter;
  onInterest: (v: UniboxInterestFilter) => void;
}) {
  const [tab, setTab] = useState<FilterTab>("status");
  const [campaignSearch, setCampaignSearch] = useState("");
  const [inboxSearch, setInboxSearch] = useState("");

  const filteredCampaigns = useMemo(() => {
    const q = campaignSearch.trim().toLowerCase();
    if (!q) return campaigns;
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, campaignSearch]);

  const filteredEaccounts = useMemo(() => {
    const q = inboxSearch.trim().toLowerCase();
    if (!q) return eaccounts;
    return eaccounts.filter((e) => e.toLowerCase().includes(q));
  }, [eaccounts, inboxSearch]);

  function toggleCampaign(id: string) {
    if (campaignIds.includes(id)) onCampaigns(campaignIds.filter((x) => x !== id));
    else onCampaigns([...campaignIds, id]);
  }

  // The read-state Select lives outside this menu, but "Clear all" still resets it.
  const active = hasActiveUniboxFilters(campaignIds, eaccount, readState, interest);
  const menuCount = campaignIds.length + (eaccount ? 1 : 0) + (interest !== "all" ? 1 : 0);

  function clearAll() {
    onCampaigns([]);
    onEaccount(null);
    onReadState("all");
    onInterest("all");
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("gap-1.5 px-2.5 data-[state=open]:bg-hover", menuCount > 0 && "text-primary")}
        >
          <ListFilter className="size-3.5" />
          Filter
          {menuCount > 0 && (
            <span className="min-w-[18px] rounded-[4px] bg-primary/10 px-1 py-0.5 text-center text-[11px] font-medium tabular-nums text-primary">
              {menuCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0 overflow-hidden">
        <div className="border-b border-border p-2">
          <SegmentedTabs
            value={tab}
            onValueChange={setTab}
            fullWidth
            size="sm"
            options={[
              { value: "status", label: "Status", tip: "Instantly status", count: interest !== "all" ? 1 : 0 },
              { value: "campaigns", label: "Campaigns", count: campaignIds.length },
              { value: "inboxes", label: "Inboxes", count: eaccount ? 1 : 0 },
            ]}
          />
        </div>

        {tab === "status" && (
          <div className="max-h-72 overflow-y-auto p-1">
            <button type="button" onClick={() => onInterest("all")} className={optionClass(interest === "all")}>
              <span className="flex-1 truncate">All statuses</span>
              {interest === "all" && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
            </button>
            {INTEREST_FILTER_OPTIONS.map((o) => (
              <button key={o.label} type="button" onClick={() => onInterest(o.value)} className={optionClass(interest === o.value)}>
                <span className={cn("size-2 shrink-0 rounded-full", o.dot)} />
                <span className="flex-1 truncate">{o.label}</span>
                {interest === o.value && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
        )}

        {tab === "campaigns" && (
          <>
            <div className="p-2 pb-1">
              <SearchInput value={campaignSearch} onChange={setCampaignSearch} placeholder="Search campaigns…" size="sm" />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filteredCampaigns.map((c) => {
                const checked = campaignIds.includes(c.id);
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleCampaign(c.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCampaign(c.id); } }}
                    className={cn(optionClass(false), "cursor-pointer")}
                  >
                    <AppCheckbox checked={checked} size="sm" />
                    <span className="truncate">{c.name}</span>
                  </div>
                );
              })}
              {filteredCampaigns.length === 0 && <p className="py-3 text-center text-[13px] text-muted-foreground">No matches</p>}
            </div>
          </>
        )}

        {tab === "inboxes" && (
          <>
            <div className="p-2 pb-1">
              <SearchInput value={inboxSearch} onChange={setInboxSearch} placeholder="Search inboxes…" size="sm" />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              <button type="button" onClick={() => onEaccount(null)} className={optionClass(!eaccount)}>
                <span className="flex-1 truncate">All inboxes</span>
                {!eaccount && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
              {filteredEaccounts.map((e) => (
                <button key={e} type="button" onClick={() => onEaccount(e)} className={optionClass(eaccount === e)}>
                  <span className="flex-1 truncate">{e}</span>
                  {eaccount === e && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
                </button>
              ))}
              {filteredEaccounts.length === 0 && <p className="py-3 text-center text-[13px] text-muted-foreground">No matches</p>}
            </div>
          </>
        )}

        <div className="flex items-center justify-end border-t border-border px-2 py-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={clearAll} disabled={!active} className="text-muted-foreground">
            Clear all filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
