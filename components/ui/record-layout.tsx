"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Attio record page: a main column (header, underline tabs, tab body) and a
 * right "Details" rail of label/value rows. Used for the lead, organisation
 * and campaign views so every record opens with the same shape.
 *
 *   <RecordLayout
 *     header={<RecordHeader avatar={…} title="Acme" subtitle="acme.com" actions={…} />}
 *     tabs={<SegmentedTabs variant="underline" … />}
 *     details={<DetailSection title="Record details"><DetailRow … /></DetailSection>}
 *   >
 *     {activeTabBody}
 *   </RecordLayout>
 */
export function RecordLayout({
  header,
  tabs,
  details,
  detailsWidth = 340,
  className,
  bodyClassName,
  children,
}: {
  header?: ReactNode;
  tabs?: ReactNode;
  details?: ReactNode;
  detailsWidth?: number;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1", className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        {tabs && <div className="shrink-0 px-6">{tabs}</div>}
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", bodyClassName)}>{children}</div>
      </div>
      {details && (
        <aside
          style={{ width: detailsWidth }}
          className="hidden shrink-0 overflow-y-auto border-l border-border bg-card lg:block"
        >
          {details}
        </aside>
      )}
    </div>
  );
}

/** Record title block: avatar/logo, name, a muted subtitle and actions. */
export function RecordHeader({
  avatar,
  title,
  subtitle,
  badges,
  actions,
  className,
}: {
  avatar?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Small tags/pills shown under the title. */
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 items-start gap-3 px-6 pb-3 pt-5", className)}>
      {avatar && <div className="shrink-0">{avatar}</div>}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold leading-tight text-foreground">{title}</h1>
        {subtitle && <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{subtitle}</div>}
        {badges && <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A collapsible group in the details rail ("Record details", "Lists"). */
export function DetailSection({
  title,
  action,
  defaultOpen = true,
  className,
  children,
}: {
  title: ReactNode;
  /** Small control on the right of the heading (e.g. an Edit button). */
  action?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("border-b border-border px-4 py-3 last:border-b-0", className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 flex flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[13px] font-medium text-foreground hover:bg-hover"
        >
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="mt-2 space-y-0.5">{children}</div>}
    </section>
  );
}

/** One attribute row: icon + muted label on the left, value on the right. */
export function DetailRow({
  icon,
  label,
  children,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-h-8 grid-cols-[minmax(0,120px)_minmax(0,1fr)] items-center gap-3 text-[13px]", className)}>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="min-w-0 truncate text-foreground">{children}</div>
    </div>
  );
}
