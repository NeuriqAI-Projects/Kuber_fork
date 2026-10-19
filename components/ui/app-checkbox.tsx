"use client";

import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export type AppCheckboxState = boolean | "indeterminate";

/**
 * Shared selection checkbox — visible in light and dark mode.
 * Uses a real border (not ring) so it stays visible inside overflow containers.
 */
export function AppCheckbox({
  checked,
  disabled,
  className,
  title,
  onClick,
  size = "md",
}: {
  checked: AppCheckboxState;
  disabled?: boolean;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  size?: "sm" | "md";
}) {
  const isOn = checked === true;
  const isPartial = checked === "indeterminate";

  return (
    <span
      role="checkbox"
      aria-checked={isPartial ? "mixed" : isOn}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded-[4px] border-[1.5px] transition-colors",
        size === "sm" ? "size-3.5" : "size-4",
        disabled && "opacity-40 cursor-not-allowed",
        !disabled && onClick && "cursor-pointer",
        isOn || isPartial
          ? "bg-primary border-primary"
          : "bg-field border-input hover:border-muted-foreground/50",
        className,
      )}
    >
      {isOn && <Check className="size-2.5 text-primary-foreground" strokeWidth={3.5} />}
      {isPartial && <Minus className="size-2.5 text-primary-foreground" strokeWidth={3.5} />}
    </span>
  );
}
