"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

const BOX_WIDTH = 224; // w-56
const VIEWPORT_MARGIN = 8;
const GAP = 6;

/**
 * A small "i" affordance for help text that would otherwise sit as a
 * permanent paragraph under every field — fine once, repetitive when the
 * same sentence appears under N identical cards (e.g. one per sequence
 * step). Hover/focus reveals it; nothing is on screen until then.
 *
 * Portaled to document.body and positioned from the icon's actual
 * getBoundingClientRect(), rather than CSS-only `absolute` + `group-hover`.
 * The CSS-only version clipped against whatever ancestor it happened to sit
 * in — a card's own overflow, a grid sibling painting over it, a scroll
 * container's top edge when the icon was near it — and each fix only ever
 * covered the one instance reported. Computing position from the real
 * viewport means it can never be clipped by an ancestor again, and it flips
 * side/alignment on its own instead of a caller having to guess and pass
 * align/side props per instance.
 */
export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  function computePosition() {
    const el = iconRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    // Prefer above (matches the old default look) unless there's genuinely
    // more room below — an icon near the top of the viewport/scroll area
    // flips down instead of clipping against that edge.
    const placement: "top" | "bottom" = spaceAbove >= 90 || spaceAbove >= spaceBelow ? "top" : "bottom";

    let left = rect.left + rect.width / 2 - BOX_WIDTH / 2;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - BOX_WIDTH - VIEWPORT_MARGIN));

    const top = placement === "top" ? rect.top - GAP : rect.bottom + GAP;
    setPos({ top, left, placement });
  }

  function show() {
    computePosition();
    setOpen(true);
  }
  function hide() {
    setOpen(false);
  }

  // A stale position after the page scrolls under an open tooltip is worse
  // than the tooltip just closing — closing is what every native hover
  // affordance does anyway.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <span
      ref={iconRef}
      className={cn("relative inline-flex align-middle", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Info className="size-3.5 text-muted-foreground hover:text-foreground cursor-help" tabIndex={0} />
      {mounted && open && pos && createPortal(
        <span
          className="pointer-events-none fixed z-100 w-56 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-lg"
          style={{
            top: pos.placement === "top" ? pos.top : pos.top,
            left: pos.left,
            transform: pos.placement === "top" ? "translateY(-100%)" : undefined,
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
