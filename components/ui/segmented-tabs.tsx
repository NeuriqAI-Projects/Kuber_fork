"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tip";

/** Shared chrome for every segmented tab bar in the app (Attio toggle: a
 *  light-gray track with the active option as a white chip). */
export const segmentedListClassName =
  "inline-flex items-center justify-center rounded-md bg-secondary p-0.5 text-muted-foreground";

export function segmentedTriggerClassName(active: boolean, size: "sm" | "md" | "lg" = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium leading-none transition-colors whitespace-nowrap",
    size === "sm" && "h-6 px-2 text-xs",
    size === "md" && "h-7 px-2.5 text-[13px]",
    size === "lg" && "h-8 px-3 text-sm gap-2",
    active
      ? "bg-field text-foreground shadow-xs"
      : "text-muted-foreground hover:text-foreground",
  );
}

/** Attio record/page tabs: text tabs on a bottom border, the active one
 *  underlined in the foreground colour. */
export const underlineListClassName = "flex items-center gap-5 border-b border-border";

export function underlineTriggerClassName(active: boolean) {
  return cn(
    "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-[13px] font-medium leading-none transition-colors whitespace-nowrap",
    active
      ? "border-foreground text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );
}

export type SegmentedTabOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
  disabled?: boolean;
  /** Instant hover tooltip for this tab. */
  tip?: string;
};

export function SegmentedTabs<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "md",
  fullWidth = false,
  variant = "segmented",
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedTabOption<T>[] | SegmentedTabOption<T>[];
  className?: string;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  /** "segmented" (default) — toggle chips on a gray track. "underline" — Attio
   *  page/record tabs on a bottom border. */
  variant?: "segmented" | "underline";
}) {
  const underline = variant === "underline";
  return (
    <div
      role="tablist"
      className={cn(underline ? underlineListClassName : segmentedListClassName, fullWidth && "w-full", className)}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        const tab = (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              underline ? underlineTriggerClassName(active) : segmentedTriggerClassName(active, size),
              fullWidth && "flex-1",
              opt.disabled && "opacity-50 pointer-events-none",
            )}
          >
            {Icon ? <Icon className={size === "sm" ? "size-3" : size === "lg" ? "size-4" : "size-3.5"} /> : null}
            <span>{opt.label}</span>
            {typeof opt.count === "number" && opt.count > 0 ? (
              <span
                className={cn(
                  "min-w-[18px] rounded-[4px] px-1 py-0.5 text-[11px] font-medium tabular-nums text-center",
                  active ? "bg-secondary text-foreground" : "bg-hover text-muted-foreground",
                )}
              >
                {opt.count}
              </span>
            ) : null}
          </button>
        );
        return opt.tip ? <Tip key={opt.value} text={opt.tip}>{tab}</Tip> : tab;
      })}
    </div>
  );
}
