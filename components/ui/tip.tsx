"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Instant hover/focus tooltip for ANY element (button, pill, link, badge) —
 * the replacement for the native `title=` attribute, which waits ~1s, can't be
 * styled and never shows on touch. Same look as InfoTip (the round "i"), which
 * is for help text that gets its own icon; this one wraps the thing itself.
 *
 * Portaled to <body> and positioned from the wrapper's real bounding box, so no
 * ancestor can clip it. Wraps in a span, so a disabled button inside still shows
 * the tip (disabled controls swallow their own mouse events, the wrapper doesn't).
 */
export function Tip({ text, children, side = "top", block = false, className }: {
  text: ReactNode; children: ReactNode; side?: "top" | "bottom"; block?: boolean; className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  function show() {
    const el = ref.current;
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    // Keep the 256px box inside the viewport.
    const left = Math.min(Math.max(r.left + r.width / 2, 136), window.innerWidth - 136);
    setPos({ top: side === "top" ? r.top - 6 : r.bottom + 6, left });
  }
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      className={cn(block ? "flex" : "inline-flex", "max-w-full", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={hide}
    >
      {children}
      {pos && mounted && createPortal(
        <span
          role="tooltip"
          style={{ position: "fixed", top: pos.top, left: pos.left, transform: side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)", zIndex: 9999 }}
          className="pointer-events-none w-64 whitespace-pre-line rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-foreground shadow-lg"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
