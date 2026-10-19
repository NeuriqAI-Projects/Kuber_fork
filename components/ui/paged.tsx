"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shows the first `first` items, then one "Show more (N of total)" button that reveals `step` more,
 * the same control the Leads list uses (no "Show less").
 * Used for every log/activity list so a long history never turns into a wall of rows.
 * `children` receives the visible slice, so the caller keeps its own table markup.
 */
export function Paged<T>({ items, first = 10, step = 10, children }: {
  items: T[]; first?: number; step?: number; children: (visible: T[]) => ReactNode;
}) {
  const [count, setCount] = useState(first);
  const shown = Math.min(count, items.length);
  return (
    <div className="space-y-3">
      {children(items.slice(0, count))}
      {count < items.length && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={() => setCount((c) => c + step)} className="h-8 text-xs">
            {`Show more (${shown} of ${items.length})`}
          </Button>
        </div>
      )}
    </div>
  );
}
