"use client";

import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { InfoTooltip } from "@/components/ui/info-tooltip";

/**
 * Attio-style settings building blocks: the grouped left menu, the page title,
 * a section header with a 1px rule under it, and the label-left / control-right
 * row. Settings, Team, Email & sending and Credits all compose these, so the
 * settings screens line up the same way.
 */

export type SettingsNavItem = {
  key: string;
  label: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  onSelect: () => void;
};

export type SettingsNavGroup = { label: string; items: SettingsNavItem[] };

/** The settings side menu: labelled groups of 32px items. Pass it as
 *  PageShell's `nav`. Empty groups are skipped. */
export function SettingsNav({ groups, className }: { groups: SettingsNavGroup[]; className?: string }) {
  return (
    <aside className={cn("w-56 shrink-0 border-r border-border overflow-y-auto px-2 py-3", className)}>
      {groups.filter((g) => g.items.length > 0).map((group, gi) => (
        <div key={group.label} className={cn(gi > 0 && "mt-4")}>
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
          <div className="space-y-px">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onSelect}
                  aria-current={item.active ? "page" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium transition-colors",
                    item.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground",
                  )}
                >
                  {Icon && <Icon className="size-4 shrink-0" />}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}

/** The 18px title at the top of a settings page, with an optional muted line
 *  and actions on the right. */
export function SettingsPageTitle({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold leading-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}

/** Section header: 15px title (+ optional info tip), muted description, a 1px
 *  rule under it, an optional tag/action on the right. */
export function SettingsSectionHeader({
  title,
  description,
  aside,
  info,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  info?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-border pb-3", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
          {info && <InfoTooltip text={info} />}
        </div>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

/** A `<section>` that starts with a SettingsSectionHeader. */
export function SettingsSection({
  title,
  description,
  aside,
  info,
  className,
  headerClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  info?: string;
  className?: string;
  headerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <SettingsSectionHeader title={title} description={description} aside={aside} info={info} className={headerClassName} />
      {children}
    </section>
  );
}

/** Label + description on the left (2fr), the control on the right (3fr);
 *  stacks below `sm`. Rows are split by a 1px rule; the last one has none. */
export function SettingsRow({
  label,
  description,
  htmlFor,
  className,
  labelClassName,
  contentClassName,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  className?: string;
  labelClassName?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-2 py-4 border-b border-border last:border-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-8", className)}>
      <div>
        <Label htmlFor={htmlFor} className={cn("text-[13px] font-medium text-foreground", labelClassName)}>{label}</Label>
        {description && <p className="text-[13px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </div>
  );
}
