"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The Filters modal shell shared by Leads and Organizations: "Refine / Filters"
 * header, scrolling body, Clear all / Cancel / Apply footer. Callers own the
 * draft state and put their fields (MultiSelectDropdown etc.) in the body.
 * A custom overlay rather than the Radix Dialog, matching the original Leads
 * filter modal.
 */
export function FilterModal({ children, onClose, onClear, onApply }: {
  children: ReactNode; onClose: () => void; onClear: () => void; onApply: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="swatch-bar-top relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-xl flex flex-col min-h-[min(34rem,85vh)] max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <p className="eyebrow">Refine</p>
            <p className="font-display text-base font-semibold mt-0.5">Filters</p>
          </div>
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="overflow-y-auto px-5 py-5 space-y-5 flex-1">{children}</div>
        <div className="flex items-center justify-between px-5 py-4 border-t border-border shrink-0">
          <Button
            variant="ghost" size="sm" onClick={onClear}
            className="h-auto p-0 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            Clear all
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={onApply}>Apply</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
