"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The frame every full-page screen sits in.
 *
 * Model Lab shipped with its own header padding, its own body padding and no
 * width limit at all, so on a wide monitor it stretched edge to edge while
 * every other screen stopped at a column. That was not carelessness — there was
 * simply nothing to inherit, so each screen re-invented the same three
 * decisions and got a different answer.
 *
 * Reach for this for a new top-level screen. It owns the header block, the
 * scroll container, the content width and the page padding; the caller supplies
 * only what is actually different.
 */
export function PageShell({
  title,
  description,
  icon,
  actions,
  banner,
  width = "wide",
  children,
}: {
  title: string;
  description?: string;
  /** Usually a lucide icon at size-5. */
  icon?: ReactNode;
  /** Buttons or tabs for the top-right of the header. */
  actions?: ReactNode;
  /** Rendered above the header, full-bleed — e.g. ServiceHealthBanner. */
  banner?: ReactNode;
  /** "wide" suits tables and card grids; "prose" keeps forms readable. */
  width?: "wide" | "prose" | "full";
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {banner}

      {/* px-8 py-5 is the app's header block — Settings, Leads and Campaigns
          all use it, so a new screen must not invent its own. */}
      <header className="shrink-0 border-b border-border px-8 py-5">
        <div className="flex flex-wrap items-center gap-3">
          {icon}
          <div className="min-w-0">
            <h1 className="font-display text-lg font-semibold">{title}</h1>
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "enter mx-auto w-full p-8",
            width === "wide" && "max-w-6xl",
            width === "prose" && "max-w-3xl",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
