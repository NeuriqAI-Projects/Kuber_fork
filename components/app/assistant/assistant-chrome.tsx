"use client";

// The panel's frame: size + close controls, the plain top bar, and the bottom tab bar.
import type { ReactNode } from "react";
import { ChevronLeft, House, Maximize, Maximize2, MessagesSquare, Minimize, Minimize2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantSize } from "@/components/app/assistant/assistant-launcher";
import { cn } from "@/lib/utils";

export type AssistantTab = "home" | "messages" | "skills";

export type PanelHost = {
  size: AssistantSize;
  phone: boolean;
  onSize: (s: AssistantSize) => void;
  onClose: () => void;
};

/** Expand / make smaller / full screen, then close. `onBrand` = white, for the Home hero. */
export function SizeControls({ host, onBrand }: { host: PanelHost; onBrand?: boolean }) {
  const { size, phone, onSize, onClose } = host;
  const tone = onBrand ? "kuber-ai-hero-btn text-white/85 hover:text-white" : undefined;
  return (
    <div className="flex items-center gap-0.5">
      {!phone && size === "compact" && (
        <Button variant="ghost" size="icon-sm" className={tone} title="Expand" aria-label="Expand" onClick={() => onSize("expanded")}>
          <Maximize2 className="size-4" />
        </Button>
      )}
      {!phone && size === "expanded" && (
        <>
          <Button variant="ghost" size="icon-sm" className={tone} title="Make smaller" aria-label="Make smaller" onClick={() => onSize("compact")}>
            <Minimize2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className={tone} title="Full screen" aria-label="Full screen" onClick={() => onSize("full")}>
            <Maximize className="size-4" />
          </Button>
        </>
      )}
      {!phone && size === "full" && (
        <Button variant="ghost" size="icon-sm" className={tone} title="Exit full screen" aria-label="Exit full screen" onClick={() => onSize("expanded")}>
          <Minimize className="size-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" className={tone} title="Close (⌘J)" aria-label="Close assistant" onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

/** The top bar on Messages, Skills and inside a conversation. */
export function TopBar({
  title, subtitle, icon, onBack, actions, host,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  host: PanelHost;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2.5">
      {onBack && (
        <Button variant="ghost" size="icon-sm" title="Back" aria-label="Back" onClick={onBack}>
          <ChevronLeft className="size-[18px]" />
        </Button>
      )}
      {icon}
      <div className="min-w-0 flex-1 pl-0.5">
        <p className="truncate text-[14px] font-semibold leading-tight">{title}</p>
        {subtitle && <p className="truncate text-[11.5px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
      <SizeControls host={host} />
    </div>
  );
}

const TABS: Array<{ key: AssistantTab; label: string; Icon: typeof House }> = [
  { key: "home", label: "Home", Icon: House },
  { key: "messages", label: "Messages", Icon: MessagesSquare },
  { key: "skills", label: "Skills", Icon: Wand2 },
];

export function TabBar({ tab, onTab }: { tab: AssistantTab; onTab: (t: AssistantTab) => void }) {
  return (
    <nav aria-label="Kuber AI" className="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid max-w-md grid-cols-3">
        {TABS.map(({ key, label, Icon }) => {
          const on = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onTab(key)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors",
                on ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("size-[18px]", on && "stroke-[2.25]")} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** "now", "5m", "3h", "Mon", "12 Oct" — short, for list rows. */
export function shortWhen(iso: string): string {
  const t = Date.parse(iso);
  const diff = Date.now() - t;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return new Date(t).toLocaleDateString("en-GB", { weekday: "short" });
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
