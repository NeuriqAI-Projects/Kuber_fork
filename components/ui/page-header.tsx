"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Crumb = {
  label: ReactNode;
  /** Usually a lucide icon at size-4; shown in a small tile before the label. */
  icon?: ReactNode;
  href?: string;
  onClick?: () => void;
};

/**
 * Attio's page top bar: a 48px strip with a breadcrumb on the left
 * ("Leads / Acme Inc") and actions on the right. Every top-level screen and
 * record view starts with one, so screens line up the same way.
 *
 * Pass `crumbs` for a path, or just `title` (+ `icon`) for a single crumb.
 */
export function PageHeader({
  crumbs,
  title,
  icon,
  description,
  actions,
  className,
}: {
  crumbs?: Crumb[];
  title?: ReactNode;
  icon?: ReactNode;
  /** Short muted text after the title — keep it to a few words. */
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const items: Crumb[] = crumbs ?? (title ? [{ label: title, icon }] : []);
  return (
    <header className={cn("flex h-12 shrink-0 items-center gap-3 border-b border-border px-4", className)}>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          const inner = (
            <>
              {c.icon && (
                <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-border bg-field text-muted-foreground [&_svg]:size-3">
                  {c.icon}
                </span>
              )}
              <span className="truncate">{c.label}</span>
            </>
          );
          const cls = cn(
            "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5",
            last ? "font-medium text-foreground" : "text-muted-foreground",
            (c.href || c.onClick) && "transition-colors hover:bg-hover hover:text-foreground",
          );
          return (
            <Fragment key={i}>
              {i > 0 && <span className="shrink-0 text-muted-foreground/50">/</span>}
              {c.href ? (
                <Link href={c.href} prefetch className={cls}>{inner}</Link>
              ) : c.onClick ? (
                <button type="button" onClick={c.onClick} className={cls}>{inner}</button>
              ) : (
                <span className={cls}>{inner}</span>
              )}
            </Fragment>
          );
        })}
        {description && <span className="ml-1 hidden truncate text-[13px] text-muted-foreground md:inline">{description}</span>}
      </nav>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * The row under the page header for view switches, Sort, Filter and search
 * (Attio's "All companies ▾  Sort  Filter" bar). Use ghost/outline `Button`
 * size="sm" inside it.
 */
export function Toolbar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5", className)}>
      {children}
    </div>
  );
}
