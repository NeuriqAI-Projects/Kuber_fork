"use client";

import { Flame, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { prefetchLead } from "@/lib/api-client";
import { TEMPERATURE_BADGE } from "@/lib/temperature-badge";
import {
  CAMPAIGN_KANBAN_COLS,
  campaignBucket,
  isFailedDraft,
  type CampaignKanbanBucket,
} from "@/lib/campaign-status";

export type CampaignKanbanLead = {
  id: string;
  /** The lead behind this campaign row — used to hover-prefetch the lead. */
  lead_id?: string;
  crm_status: string;
  lead_temperature: string | null;
  leads: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    title: string | null;
  } | null;
  email_drafts: { id: string; status: string } | null;
};

const COL_COUNT = CAMPAIGN_KANBAN_COLS.length;

export function CampaignKanban({
  leads,
  selectedId,
  onSelect,
  onRetry,
  retryingId,
}: {
  leads: CampaignKanbanLead[];
  selectedId: string | null;
  onSelect: (campaignLeadId: string) => void;
  onRetry?: (draftId: string, campaignLeadId: string) => void;
  retryingId?: string | null;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <p className="px-6 pt-3 text-xs text-muted-foreground shrink-0">
        Click a lead to open in Leads view for review and certification.
      </p>
      <div className="flex gap-3 overflow-x-auto min-h-0 flex-1 px-6 py-3">
        {CAMPAIGN_KANBAN_COLS.map((col) => {
          const colLeads = leads.filter((cl) => campaignBucket(cl) === col.id);
          return (
            <div
              key={col.id}
              className="shrink-0 flex flex-col min-h-0 self-stretch rounded-lg border border-border bg-secondary"
              style={{
                width: `calc((100% - ${(COL_COUNT - 1) * 12}px) / ${COL_COUNT})`,
                minWidth: "200px",
              }}
            >
              {/* Attio board column: plain header with a status dot and count. */}
              <div className="flex h-9 items-center gap-2 px-3 shrink-0">
                <span className={cn("size-2 rounded-full shrink-0", col.dot)} />
                <span className="truncate text-[13px] font-medium text-foreground">{col.label}</span>
                <span className="ml-auto rounded-[4px] bg-hover px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground shrink-0">
                  {colLeads.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                {colLeads.map((cl) => {
                  const lead = cl.leads;
                  const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unknown";
                  const isFailed = isFailedDraft(cl);
                  const isSelected = selectedId === cl.id;
                  const isRetrying = retryingId === cl.id;
                  return (
                    <div
                      key={cl.id}
                      className={cn(
                        "shrink-0 rounded-md border bg-card p-2.5 cursor-pointer shadow-xs transition-colors overflow-hidden",
                        isFailed ? "border-red-300 dark:border-red-500/40" : "border-border",
                        isSelected ? "border-primary/50 bg-primary/5" : "hover:bg-hover",
                      )}
                      onClick={() => onSelect(cl.id)}
                      onMouseEnter={cl.lead_id ? () => prefetchLead(cl.lead_id!) : undefined}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(cl.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-start gap-2">
                        <Avatar name={name} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium truncate">{name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {lead?.title || lead?.email}
                          </p>
                        </div>
                        {cl.crm_status === "replied" && cl.lead_temperature === "hot" && (
                          <span className={cn("shrink-0 inline-flex items-center gap-0.5 rounded-[5px] border px-1.5 py-[3px] text-[11px] font-medium leading-none", TEMPERATURE_BADGE.hot.cls)}>
                            <Flame className="size-2.5" /> Hot
                          </span>
                        )}
                      </div>
                      {isFailed && onRetry && cl.email_drafts?.id && (
                        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 w-full text-xs text-destructive hover:text-destructive [&_svg]:size-3"
                            disabled={!!retryingId}
                            onClick={() => onRetry(cl.email_drafts!.id, cl.id)}
                          >
                            {isRetrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                            Retry
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function countByBucket(leads: CampaignKanbanLead[]): Record<CampaignKanbanBucket, number> {
  const counts: Record<CampaignKanbanBucket, number> = {
    pending: 0,
    draft: 0,
    approved: 0,
    sent: 0,
    replied: 0,
  };
  for (const cl of leads) counts[campaignBucket(cl)]++;
  return counts;
}
