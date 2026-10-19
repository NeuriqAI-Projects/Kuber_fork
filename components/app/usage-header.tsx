"use client";

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";

/** The one header row every Usage section starts with: "USAGE (i)" on the left,
 *  any extra control and Refresh on the right. Keeps the section tight instead of
 *  spending a whole row on a lone Refresh button. */
export function UsageHeader({ info, refreshing, onRefresh, extra }: {
  info: string; refreshing: boolean; onRefresh: () => void; extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <h3 className="font-display text-2xl font-bold tracking-tight flex items-center gap-2">Usage <InfoTip side="bottom" text={info} /></h3>
      <div className="flex items-center gap-3">
        {extra}
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} className="shrink-0 gap-1.5">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}
