"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The frame for a custom modal that must open on top of a drawer (a Radix
 * Dialog): a portal to <body>, a z-200 overlay, the dimmed backdrop and the
 * popover-coloured panel. The caller supplies the panel's width and content.
 *
 * Why not DialogContent: a Radix Dialog open behind this one sets
 * `document.body.style.pointerEvents = "none"` for as long as it is open and
 * only re-enables `auto` on its own content node. This overlay is a body child
 * but not a registered Radix layer, so without the forced `pointer-events-auto`
 * it inherits `none` — clicks land on it visually but pass straight through,
 * and every button looks dead. Radix also treats any click outside its content
 * as "close"; components/ui/dialog.tsx ignores clicks inside
 * `[data-confirm-dialog-root]`, so the drawer behind stays open.
 *
 * Portaled to <body> rather than rendered in place: callers often sit inside
 * an `overflow-hidden` card or a transformed ancestor (a hover-scale utility,
 * an animation that leaves `transform` set), which either clips the overlay or
 * becomes the containing block for `position: fixed`, so the "full-viewport"
 * overlay is sized to that ancestor instead. (`.enter`'s fade-up once did
 * exactly that via `animation-fill-mode: both`.)
 *
 * ConfirmDialog, the campaign Hold / Regenerate / Replace modals, the import
 * preview and the Team handover/territory modals all use this.
 */
export function ModalShell({
  onClose,
  closeDisabled,
  className,
  children,
}: {
  /** Called when the backdrop is clicked. */
  onClose: () => void;
  /** Ignore backdrop clicks — e.g. while a submit is in flight. */
  closeDisabled?: boolean;
  /** Panel classes: width (`max-w-md`), and `flex flex-col max-h-[90vh]
   *  overflow-hidden` for a scrolling body. */
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  return createPortal(
    <div data-confirm-dialog-root className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      <div className="absolute inset-0 bg-black/25 dark:bg-black/60" onClick={closeDisabled ? undefined : onClose} />
      <div
        className={cn(
          "relative z-10 mx-4 w-full rounded-xl border border-border bg-popover text-popover-foreground shadow-xl",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
