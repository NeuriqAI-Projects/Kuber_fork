"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PageHeader, type Crumb } from "@/components/ui/page-header";

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
 *
 * Pages with their own side menu (Settings) pass it as `nav`: the menu sits on
 * the left under the header and only the content column scrolls. A strip under
 * the header that must not scroll away (Credits' service tabs) goes in
 * `subheader`.
 */
export function PageShell({
  title,
  crumbs,
  description,
  icon,
  actions,
  banner,
  subheader,
  nav,
  width = "wide",
  contentClassName,
  children,
}: {
  /** A single crumb. Pass `crumbs` instead for a path. */
  title?: string;
  crumbs?: Crumb[];
  description?: ReactNode;
  /** Usually a lucide icon; shown in the breadcrumb tile. */
  icon?: ReactNode;
  /** Buttons or tabs for the top-right of the header. */
  actions?: ReactNode;
  /** Rendered above the header, full-bleed — e.g. ServiceHealthBanner. */
  banner?: ReactNode;
  /** Rendered under the header, outside the scroll area — e.g. underline tabs. */
  subheader?: ReactNode;
  /** A side menu (e.g. SettingsNav) left of the scrolling content. */
  nav?: ReactNode;
  /** "wide" suits tables and card grids; "prose" keeps forms readable.
   *  "none" leaves width and padding to the children (a page whose column
   *  width changes per section). */
  width?: "wide" | "prose" | "full" | "none";
  /** Extra classes on the content column, e.g. `space-y-8`. */
  contentClassName?: string;
  children: ReactNode;
}) {
  const content =
    width === "none" ? (
      children
    ) : (
      <div
        className={cn(
          "mx-auto w-full px-6 py-6",
          width === "wide" && "max-w-6xl",
          width === "prose" && "max-w-3xl",
          contentClassName,
        )}
      >
        {children}
      </div>
    );

  return (
    <div className={cn("flex h-full flex-col", nav && "overflow-hidden")}>
      {banner}

      <PageHeader crumbs={crumbs} title={title} icon={icon} description={description} actions={actions} />

      {subheader}

      {nav ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {nav}
          <div className="relative min-w-0 flex-1 overflow-y-auto">{content}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      )}
    </div>
  );
}
