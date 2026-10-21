"use client";

// How Kuber AI opens: a floating launcher pill, and three panel sizes —
//   compact   a floating card in the bottom-right corner (default)
//   expanded  a full-height panel docked on the right; the page shrinks beside it
//   full      full screen over a dimmed page
// Phones always get full screen. Modelled on the Chatty help widget.
import { useCallback, useEffect, useState } from "react";
import { KuberAiMark } from "@/components/app/assistant/kuber-ai-mark";
import { cn } from "@/lib/utils";

export type AssistantSize = "compact" | "expanded" | "full";

const SIZE_KEY = "kuber_assistant_size";

/** The last size the user picked, per browser. Full screen is never restored — it reopens expanded. */
export function useAssistantSize(): [AssistantSize, (s: AssistantSize, opts?: { remember?: boolean }) => void] {
  const [size, setSizeState] = useState<AssistantSize>("compact");
  useEffect(() => {
    try {
      const v = localStorage.getItem(SIZE_KEY);
      if (v === "expanded" || v === "full") setSizeState("expanded");
    } catch { /* storage blocked — compact */ }
  }, []);
  const setSize = useCallback((s: AssistantSize, opts?: { remember?: boolean }) => {
    setSizeState(s);
    if (opts?.remember === false) return;
    try { localStorage.setItem(SIZE_KEY, s); } catch { /* lasts for this page */ }
  }, []);
  return [size, setSize];
}

/** Below 640px the panel is always full screen. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** The panel's box for each size. Expanded stays in the page's flex row, so the page makes room for it. */
export function assistantPanelClass(size: AssistantSize, phone: boolean): string {
  if (phone) return "fixed inset-0 z-50";
  if (size === "expanded") return "relative h-screen w-[clamp(400px,34vw,620px)] shrink-0 border-l border-border";
  if (size === "full") return "fixed inset-4 z-50 rounded-2xl border border-border shadow-2xl sm:inset-6";
  return "fixed bottom-5 right-5 z-50 h-[min(42rem,calc(100dvh-2.5rem))] w-[min(28rem,calc(100vw-2.5rem))] rounded-2xl border border-border shadow-2xl";
}

/** The bubble in the bottom-right corner while the panel is closed: logo + ⌘J, and the label slides out on hover. */
export function AssistantLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Ask Kuber AI"
      title="Ask Kuber AI (⌘J)"
      className="kuber-ai-launcher group fixed bottom-5 right-5 z-40 flex h-11 items-center rounded-full border border-border bg-popover py-1.5 pl-1.5 pr-3 text-foreground shadow-[0_10px_30px_-12px_rgb(15_23_42/0.45)] transition-shadow hover:shadow-[0_14px_36px_-12px_rgb(79_70_229/0.55)]"
    >
      <KuberAiMark className="size-8" />
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-[13.5px] font-semibold opacity-0 transition-all duration-150 group-hover:ml-2 group-hover:max-w-40 group-hover:opacity-100">Ask Kuber AI</span>
      <kbd className={cn("ml-2 hidden sm:inline text-[11px] font-medium text-muted-foreground")}>⌘J</kbd>
    </button>
  );
}
