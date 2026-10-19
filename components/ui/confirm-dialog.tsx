"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Pause, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";

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
 * Built on ModalShell, not the Radix `Dialog` primitive: it renders above
 * drawers (z-50/z-60), so it needs its own z-200 overlay. modal-shell.tsx
 * explains the portal and the forced `pointer-events: auto`.
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
  if (!open) return null;

  const isWarning = tone === "warning";

  return (
    <ModalShell onClose={onClose} closeDisabled={loading} className="flex max-w-md flex-col gap-5 overflow-hidden p-5">
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
    </ModalShell>
  );
}
