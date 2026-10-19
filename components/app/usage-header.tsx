"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-context";
import { useCached } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";

/** The one header row every Usage section starts with: "Usage (i)" on the left,
 *  any extra control and Refresh on the right. Keeps the section tight instead of
 *  spending a whole row on a lone Refresh button. */
export function UsageHeader({ info, refreshing, onRefresh, extra }: {
  info: string; refreshing: boolean; onRefresh: () => void; extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
      <h3 className="flex items-center gap-1.5 text-[15px] font-semibold leading-tight">Usage <InfoTip side="bottom" text={info} /></h3>
      <div className="flex items-center gap-2">
        {extra}
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} className="shrink-0">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}

/** Centered muted line for an empty chart / table. */
export function UsageEmpty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[13px] text-muted-foreground">{children}</p>;
}

/** Key-check / warning strip in the light/dark tag colours. */
export function UsageNotice({ tone, children }: { tone: "error" | "warning" | "ok"; children: ReactNode }) {
  return (
    <div className={cn(
      "rounded-lg border px-3.5 py-2.5 text-[13px]",
      tone === "error" && "border-red-200 bg-red-50 text-red-900 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300",
      tone === "warning" && "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300",
      tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300",
    )}>
      {children}
    </div>
  );
}

/** Thin credit bar: label + "used / limit" on one line, a 4px bar under it. */
export function UsageProgress({ label, value, pct }: { label: ReactNode; value: ReactNode; pct: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-amber-500" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Status dot + label for ledger rows. */
export function UsageStatus({ tone, children }: { tone: "ok" | "bad" | "warn" | "muted"; children: ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5",
      tone === "ok" && "text-emerald-700 dark:text-emerald-400",
      tone === "bad" && "text-destructive",
      tone === "warn" && "text-amber-700 dark:text-amber-400",
      tone === "muted" && "text-muted-foreground",
    )}>
      <span className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "bad" && "bg-destructive",
        tone === "warn" && "bg-amber-500",
        tone === "muted" && "bg-muted-foreground",
      )} />
      {children}
    </span>
  );
}

/**
 * Load + refresh plumbing for every Usage tab, through the shared query cache:
 * a revisit paints the last copy at once and revalidates quietly. Refresh asks
 * the route to re-check the provider (`?refresh=1`) and writes the result back
 * under the same key.
 */
export function useCachedUsage<T>(key: string, fetcher: (token: string, refresh: boolean) => Promise<T>) {
  const { session } = useApp();
  const token = session?.access_token ?? "";
  const query = useCached<T>(session ? key : null, () => fetcher(token, false));
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (query.error) toast.error((query.error as Error).message ?? "Could not load usage");
  }, [query.error]);

  const { mutate, revalidate } = query;
  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (!refresh) { await revalidate().catch(() => {}); return; }
    setRefreshing(true);
    try { mutate(await fetcher(session.access_token, true)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  }, [session, fetcher, mutate, revalidate]);

  return { data: query.data ?? null, loading: query.isLoading, refreshing, load };
}
