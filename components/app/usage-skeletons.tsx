import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/** Shared building blocks for the Settings > Keys > Usage loading states —
 *  shaped to match each tab's real layout so content doesn't jump around
 *  once data arrives. */

/** The Usage heading is real text (not a bar) so it is on screen from the first frame and
 *  sits where UsageHeader puts it; only the Refresh button is a placeholder. */
export function UsageHeaderSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
      <h3 className="text-[15px] font-semibold leading-tight">Usage</h3>
      <Skeleton className="h-7 w-24 shrink-0" />
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      <Skeleton className="size-7 rounded-md" />
      <div className="space-y-1.5">
        <Skeleton className="h-5 w-14" />
        <Skeleton className="h-2.5 w-16" />
      </div>
    </div>
  );
}

export function StatTileGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => <StatTileSkeleton key={i} />)}
    </div>
  );
}

const BAR_HEIGHTS = [40, 65, 30, 80, 50, 90, 35, 60, 45, 75, 55, 25, 70, 85];

export function ChartCardSkeleton({ titleWidth = "w-32", subWidth = "w-56" }: { titleWidth?: string; subWidth?: string }) {
  return (
    <Card>
      <div className="flex min-h-12 flex-col justify-center gap-1.5 border-b border-border px-4 py-2.5">
        <Skeleton className={`h-3 ${titleWidth}`} />
        <Skeleton className={`h-2.5 ${subWidth}`} />
      </div>
      <div className="h-[200px] m-4 flex items-end gap-2 px-1">
        {BAR_HEIGHTS.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-sm rounded-b-none" style={{ height: `${h}%` }} />
        ))}
      </div>
    </Card>
  );
}

export function RowsCardSkeleton({ rows = 4, titleWidth = "w-32" }: { rows?: number; titleWidth?: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-12 items-center border-b border-border px-4 py-2.5">
        <Skeleton className={`h-3 ${titleWidth}`} />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex h-9 items-center gap-4 px-3">
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ProgressRowSkeleton() {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <Skeleton className="h-1 w-full rounded-full" />
    </div>
  );
}
