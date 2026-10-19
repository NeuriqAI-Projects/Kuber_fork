import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Optional bold first line (Attio: "No tasks found"); `message` sits under it. */
  title?: React.ReactNode;
  message: React.ReactNode;
  icon?: LucideIcon;
  /**
   * Renders the message inside its own panel. Turn this off when the empty
   * state already sits inside a panel, table cell, or chart area — boxing it
   * there would nest a card inside a card.
   */
  boxed?: boolean;
  className?: string;
  /** Optional call to action rendered under the message. */
  children?: React.ReactNode;
}

export function EmptyState({
  title,
  message,
  icon: Icon,
  boxed = true,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 text-center",
        boxed
          ? "rounded-lg border border-border bg-card px-6 py-14"
          : "py-12",
        className,
      )}
    >
      {Icon && (
        <div className="grid size-10 place-items-center rounded-lg border border-border bg-field text-muted-foreground shadow-sm">
          <Icon className="size-[18px]" />
        </div>
      )}
      <div className="space-y-1">
        {title && <p className="text-sm font-semibold text-foreground">{title}</p>}
        <p className="text-[13px] text-muted-foreground">{message}</p>
      </div>
      {children}
    </div>
  );
}
