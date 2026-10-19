"use client";

import { Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Lead, LeadStatus } from "@/lib/leads";
import { kanbanColumnFor, inputRequiredReason } from "@/lib/leads";
import { Button } from "@/components/ui/button";
import { Avatar, ScoreBadge } from "@/components/leads/lead-ui";
import { prefetchLead } from "@/lib/api-client";

const KANBAN_COLS: { id: LeadStatus; label: string; hint?: string; dot: string }[] = [
  { id: "New",            label: "New",            hint: "Enrichment in progress", dot: "bg-zinc-400" },
  { id: "Input Required", label: "Input required", hint: "Enrichment concluded — needs attention", dot: "bg-yellow-500" },
  { id: "Enriched",       label: "Enriched",       dot: "bg-blue-500" },
  { id: "Open",           label: "Win",            dot: "bg-green-500" },
  { id: "Closed",         label: "Closed",         dot: "bg-zinc-300 dark:bg-zinc-600" },
];

export function KanbanBoard({
  leads,
  onCardClick,
  onRetryAllFailed,
  retryingAll,
  columnTotals,
}: {
  leads: Lead[];
  onCardClick: (lead: Lead) => void;
  /** Manager-only bulk retry for the "failed website" flavour of Input Required. Omit to hide the action. */
  onRetryAllFailed?: () => void;
  retryingAll?: boolean;
  /** True per-stage totals from the database, keyed by display status. Without
   *  these the header numbers count only the leads the browser has loaded — the
   *  same account read 999 on the Dashboard and 500 across these columns.
   *  Omitted when a filter or search is active, because `leads` is then already
   *  the complete server-filtered set and counting it is correct. */
  columnTotals?: Partial<Record<LeadStatus, number>>;
}) {
  return (
    <div className="flex min-h-[500px] gap-3 overflow-x-auto pb-4">
      {KANBAN_COLS.map((col) => {
        const colLeads = leads.filter((l) => kanbanColumnFor(l) === col.id);
        const colTotal = columnTotals?.[col.id] ?? colLeads.length;
        const failedCount = col.id === "Input Required"
          ? colLeads.filter((l) => inputRequiredReason(l) === "failed").length
          : 0;
        const showRetry = col.id === "Input Required" && !!onRetryAllFailed && failedCount > 0;
        return (
          <div
            key={col.id}
            className="flex shrink-0 flex-col gap-2"
            style={{ width: "calc((100% - 48px) / 5)", minWidth: "200px" }}
          >
            <div className="flex h-8 items-center gap-2 px-1" title={col.hint}>
              <span className={cn("size-2 shrink-0 rounded-full", col.dot)} />
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{col.label}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{colTotal}</span>
              {showRetry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRetryAllFailed}
                  disabled={retryingAll}
                  title={`Retry enrichment for every failed company in this list: about ${failedCount} Firecrawl credit${failedCount === 1 ? "" : "s"} (1 per company) plus a few cents of AI`}
                  className="ml-auto h-6 shrink-0 gap-1 px-1 text-xs text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                >
                  <RotateCcw className={cn("size-3", retryingAll && "animate-spin")} />
                  Retry
                </Button>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              {colLeads.map((lead) => {
                const reason = inputRequiredReason(lead);
                return (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => onCardClick(lead)}
                    onMouseEnter={() => prefetchLead(lead.id)}
                    className={cn(
                      "relative block w-full cursor-pointer rounded-lg border bg-card p-2.5 text-left shadow-xs transition-colors hover:bg-hover",
                      reason === "failed" ? "border-amber-300 dark:border-amber-500/40" : reason === "missing_data" ? "border-red-300 dark:border-red-500/40" : "border-border",
                    )}
                    title={reason === "failed" && lead.lastError ? lead.lastError : undefined}
                  >
                    {reason === "missing_data" && (
                      <span title="No email found — add one before this lead can be contacted" className="absolute right-2 top-2.5 text-red-600 dark:text-red-400">
                        <Info className="size-3" />
                      </span>
                    )}
                    {reason === "failed" && (
                      <span title="No usable website — campaigns will use the generic template. Open to retry enrichment." className="absolute right-2 top-2.5 text-amber-600 dark:text-amber-400">
                        <RotateCcw className="size-3" />
                      </span>
                    )}
                    <div className="flex min-w-0 items-center gap-2 pr-4">
                      <span className="shrink-0 [&>div]:size-5 [&>div]:text-[9px]">
                        <Avatar name={`${lead.firstName} ${lead.lastName}`} size="sm" />
                      </span>
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {lead.firstName} {lead.lastName}
                      </p>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{lead.company}</p>
                    <div className="mt-2 flex items-center justify-between gap-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {reason === "failed"
                          ? "No website — generic template"
                          : reason === "missing_data"
                          ? "Needs email"
                          : lead.jobTitle}
                      </span>
                      {lead.score !== "—" && <ScoreBadge score={lead.score} />}
                    </div>
                  </button>
                );
              })}
              {colLeads.length === 0 && (
                <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-6">
                  <p className="text-xs text-muted-foreground">Empty</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
