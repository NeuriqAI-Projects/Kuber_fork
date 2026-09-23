"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { X, Users } from "lucide-react";
import type { PreviewLead } from "@/lib/api-client";

interface BatchConfirmModalProps {
  source: "apollo" | "excel" | "manual";
  leads: PreviewLead[];
  totalCount?: number;
  confirming?: boolean;
  progressText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BatchConfirmModal(props: BatchConfirmModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(<BatchConfirmModalInner {...props} />, document.body);
}

function BatchConfirmModalInner({
  source,
  leads,
  totalCount,
  confirming,
  progressText,
  onConfirm,
  onCancel,
}: BatchConfirmModalProps) {
  const sourceLabel = source === "apollo" ? "Apollo Search" : source === "excel" ? "Excel / CSV" : "Manual Entry";
  const extra       = totalCount && totalCount > leads.length ? totalCount - leads.length : 0;

  return (
    // `data-confirm-dialog-root` + forced `pointer-events-auto` are required
    // because this modal portals to document.body while a Radix Dialog (the
    // Add Leads drawer) is open behind it: Radix sets `pointer-events: none`
    // on <body> while open, which would otherwise make every button here
    // unclickable, and its outside-interaction detection would close the
    // drawer (unmounting this modal) on any click inside it. See the same
    // treatment in components/ui/confirm-dialog.tsx and components/ui/dialog.tsx.
    <div data-confirm-dialog-root className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />

      <div className="enter swatch-bar-top overflow-hidden relative z-10 w-full max-w-4xl mx-4 rounded-2xl border border-border bg-card shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <p className="eyebrow">{sourceLabel}</p>
            <h2 className="font-display text-base font-semibold mt-0.5">Preview &amp; Confirm Import</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Review leads before confirming</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCancel}
            className="size-8 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Lead count */}
        {totalCount !== undefined && (
          <div className="px-6 py-2.5 border-b border-border shrink-0 flex items-center gap-1.5 bg-secondary">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{totalCount}</span> lead{totalCount !== 1 ? "s" : ""} will be imported
              {source === "apollo" && " (emails enriched post-import)"}
            </span>
          </div>
        )}

        {/* Lead preview table */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center gap-2 px-6">
              <p className="text-sm font-medium">No preview available</p>
              {source === "apollo" && (
                <p className="text-xs text-muted-foreground max-w-xs">
                  Apollo emails are revealed after import and enrichment.
                </p>
              )}
            </div>
          ) : (
            <table className="w-full text-xs table-fixed">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[24%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="sticky top-0 bg-card border-b border-border">
                <tr>
                  {["Name", "Email", "Organisation", "Domain", "Job Title"].map((h) => (
                    <th key={h} className="eyebrow text-left px-3 py-2.5 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((l, i) => (
                  <tr key={i} className="hover:bg-secondary transition-colors align-top">
                    <td className="px-3 py-2.5 font-medium leading-snug wrap-break-word">
                      {[l.firstName, l.lastName].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground font-mono text-[11px] truncate max-w-0">{l.email || "—"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground truncate max-w-0">{l.company || "—"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground font-mono text-[11px] truncate max-w-0">
                      {l.domain ? (
                        <a href={/^https?:\/\//i.test(l.domain) ? l.domain : `https://${l.domain}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{l.domain}</a>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground truncate max-w-0">{l.jobTitle || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {extra > 0 && (
            <p className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground border-t border-border">
              +{extra} more lead{extra !== 1 ? "s" : ""} will be imported
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border shrink-0">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={confirming}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={confirming}>
            {confirming ? (progressText || "Importing…") : "Confirm & Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
