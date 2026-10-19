"use client";

import { cn } from "@/lib/utils";

/**
 * Shared selection radio — same visual language as AppCheckbox (real border,
 * not a ring, so it stays visible inside overflow containers).
 */
export function AppRadio({
  checked,
  disabled,
  className,
  onClick,
  size = "md",
}: {
  checked: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  size?: "sm" | "md";
}) {
  return (
    <span
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded-full border-[1.5px] transition-colors",
        size === "sm" ? "size-3.5" : "size-4",
        disabled && "opacity-40 cursor-not-allowed",
        !disabled && onClick && "cursor-pointer",
        checked ? "border-primary bg-primary" : "border-input bg-field hover:border-muted-foreground/50",
        className,
      )}
    >
      {checked && (
        <span className={cn("rounded-full bg-primary-foreground", size === "sm" ? "size-1" : "size-1.5")} />
      )}
    </span>
  );
}
