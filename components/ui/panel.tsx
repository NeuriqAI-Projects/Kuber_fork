import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered card with a header strip: title, muted description, and an
 * optional right side. Dashboard panels and the Credits usage reports both use
 * it, so a header height or padding fix lands everywhere at once.
 *
 * `actions` sits on the right as-is (buttons, a Select). `aside` is for a short
 * fact instead ("1,204 total") and gets the muted 12px tabular style.
 */
export function Panel({
  title,
  description,
  actions,
  aside,
  flush = false,
  truncate = false,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  /** Drop the body padding — for a table or list that runs edge to edge. */
  flush?: boolean;
  /** Keep the title and description on one line each, with an ellipsis. */
  truncate?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col rounded-lg border border-border bg-card", className)}>
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h3 className={cn("text-sm font-semibold leading-tight", truncate && "truncate")}>{title}</h3>
          {description && (
            <p className={cn("mt-0.5 text-xs text-muted-foreground", truncate && "truncate")}>{description}</p>
          )}
        </div>
        {actions}
        {aside && <div className="shrink-0 text-xs tabular-nums text-muted-foreground">{aside}</div>}
      </header>
      <div className={cn("flex-1", !flush && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}
