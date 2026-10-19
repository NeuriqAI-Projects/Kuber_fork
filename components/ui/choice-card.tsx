"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AppRadio } from "@/components/ui/app-radio";
import { AppCheckbox } from "@/components/ui/app-checkbox";

/**
 * A radio/checkbox rendered as a clickable bordered box — strategy pickers,
 * "Skip already assigned leads", theme tiles. It is a field, so it is
 * `bg-field` with a `border-border` line, and turns `border-primary/50
 * bg-primary/5` when selected (root CLAUDE.md component table).
 *
 * Pass `title` + `description` for the usual two lines, or `children` for
 * anything else (a swatch, an icon row). `indicator` adds the shared radio dot
 * or checkbox on the left.
 */
export function ChoiceCard({
  selected,
  onSelect,
  disabled,
  indicator = "none",
  indicatorClassName = "mt-0.5",
  title,
  description,
  className,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  indicator?: "radio" | "checkbox" | "none";
  /** Nudges the dot to line up with the title's first line. */
  indicatorClassName?: string;
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={indicator === "checkbox" ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-left text-foreground transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-primary/50 bg-primary/5" : "border-border bg-field enabled:hover:bg-hover",
        className,
      )}
    >
      {indicator !== "none" && (
        <span aria-hidden className="contents">
          {indicator === "radio" ? (
            <AppRadio checked={selected} disabled={disabled} className={indicatorClassName} />
          ) : (
            <AppCheckbox checked={selected} disabled={disabled} className={indicatorClassName} />
          )}
        </span>
      )}
      {children ?? (
        <span className="min-w-0">
          {title && <span className="block text-[13px] font-medium">{title}</span>}
          {description && <span className="block text-xs text-muted-foreground">{description}</span>}
        </span>
      )}
    </button>
  );
}
