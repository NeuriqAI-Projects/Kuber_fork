"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Pause, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** Label for the confirming action. Defaults to "Delete". */
  confirmLabel?: string;
  /** Visual tone of the confirm action. "destructive" (red) is the default; use "warning" (amber) for non-destructive but disruptive actions like pausing. */
  tone?: "destructive" | "warning";
  loading?: boolean;
  /** Blocks confirming without showing the loading spinner. */
  confirmDisabled?: boolean;
  /** Replaces the default tone icon on the confirm button. */
  confirmIcon?: ReactNode;
  /** Optional third choice, shown between Cancel and the confirm action
   *  (e.g. "Use original" next to "Save & certify"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Destructive confirmation modal.
 *
 * Deliberately not built on the Radix `Dialog` primitive: it renders above
 * drawers (z-50/z-60), so it needs its own z-[200] overlay.
 *
 * Portaled to `document.body` rather than rendered in place — callers often
 * nest this inside an `overflow-hidden` card or a transformed ancestor (a
 * hover-scale utility, an animation library), any of which either clips this
 * dialog's overlay or turns it into a containing block for `position: fixed`
 * descendants, sizing and positioning the "fixed, full-viewport" overlay
 * relative to that ancestor's box instead of the viewport. (`.enter` used to
 * be exactly such an ancestor — its fade-up animation permanently kept a
 * `transform: translateY(0)` after finishing, via `animation-fill-mode:
 * both` — until that was fixed in globals.css; nothing in this app's `.enter`
 * elements does this anymore, but the portal stays as the general-case
 * defense against whichever ancestor does it next.)
 *
 * `pointer-events: auto` is forced on the root below because a Radix `Dialog`
 * left open behind this one sets `document.body.style.pointerEvents = "none"`
 * for the whole time it's open (its modal-blocking mechanism) and only
 * re-enables `auto` on its own content node. This dialog is a body child too,
 * but isn't a registered Radix layer, so without the override it silently
 * inherits `pointer-events: none` from body — clicks land on it visually but
 * pass straight through to whatever Radix left clickable underneath, so
 * "Cancel"/"Remove" appear completely unresponsive.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  tone = "destructive",
  loading,
  confirmDisabled,
  confirmIcon,
  secondaryLabel,
  onSecondary,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  if (!open || typeof document === "undefined") return null;

  const isWarning = tone === "warning";

  return createPortal(
    <div data-confirm-dialog-root className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-auto">
      <div
        className="absolute inset-0 bg-black/25 dark:bg-black/60"
        onClick={() => { if (!loading) onClose(); }}
      />
      <div className="relative z-10 w-full max-w-md mx-4 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl p-5 flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <div className={`shrink-0 size-8 rounded-md flex items-center justify-center ${isWarning ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-destructive/10 text-destructive"}`}>
            <AlertTriangle className="size-4" />
          </div>
          <div className="pt-0.5">
            <p className="font-semibold text-[15px] leading-tight">{title}</p>
            <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">{description}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          {secondaryLabel && onSecondary && (
            <Button type="button" variant="outline" onClick={onSecondary} disabled={loading}>
              {secondaryLabel}
            </Button>
          )}
          <Button type="button" variant={isWarning ? "warning" : "destructive"} onClick={onConfirm} disabled={loading || confirmDisabled} className="gap-2">
            {loading ? <RefreshCw className="animate-spin" /> : confirmIcon ?? (isWarning ? <Pause /> : <Trash2 />)}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
