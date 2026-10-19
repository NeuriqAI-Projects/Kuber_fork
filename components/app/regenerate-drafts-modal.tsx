"use client";

import { useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X, RotateCcw, Loader2, Lock } from "lucide-react";
import type { RegenerationSkipped } from "@/lib/api-client";

const INSTRUCTION_MAX_LENGTH = 4000;

interface RegenerateDraftsModalProps {
  /** Eligible drafts split by current state — what will actually be rewritten.
   *  `approved` matters on follow-up steps, where every written follow-up is. */
  counts: { draft: number; failed: number; approved: number };
  /** What the run will leave alone, and why. */
  skipped: RegenerationSkipped;
  /** True when the user ticked specific leads rather than targeting the whole campaign. */
  isSubset: boolean;
  /** 1 for the opening email, 2+ for a follow-up step. */
  stepNumber: number;
  /** The campaign has AI follow-ups switched off, so this run replaces each
   *  follow-up with the step's own text and asks the model nothing — the
   *  instruction box would be a lie. */
  aiOff: boolean;
  submitting?: boolean;
  onConfirm: (instruction: string) => void;
  onCancel: () => void;
}

export function RegenerateDraftsModal({
  counts,
  skipped,
  isSubset,
  stepNumber,
  aiOff,
  submitting,
  onConfirm,
  onCancel,
}: RegenerateDraftsModalProps) {
  const [instruction, setInstruction] = useState("");
  const total = counts.draft + counts.failed + counts.approved;
  const verb = aiOff ? "Replace" : "Regenerate";

  const protectedRows = [
    { n: skipped.certified,  label: "certified" },
    { n: skipped.sent,       label: "sent" },
    { n: skipped.customized, label: "customized for that lead" },
    { n: skipped.no_draft,   label: "no draft" },
  ].filter((r) => r.n > 0);

  const scopeNotes = [
    isSubset && "only your selected leads",
    counts.failed > 0 && `${counts.failed} of these previously failed and will be retried from scratch`,
  ].filter(Boolean) as string[];

  return (
    // Opens over the campaign drawer, so it uses ModalShell (portal + z-200 +
    // data-confirm-dialog-root) rather than DialogContent.
    <ModalShell onClose={onCancel} closeDisabled={submitting} className="flex max-h-[90vh] max-w-lg flex-col overflow-hidden">

      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">
            {verb} <span className="tabular-nums">{total}</span> {stepNumber > 1 ? "follow-up" : "draft"}{total !== 1 ? "s" : ""}
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1.5">
            {aiOff
              ? `AI follow-ups are switched off for this campaign. Each of these will be replaced with the Follow-up ${stepNumber - 1} text from the Sequences tab, or the company default where that box is empty, with the name and company filled in. No AI credits are used. Prior versions stay in history.`
              : "With an instruction, each draft is edited from its current wording. Without one, each gets a fresh AI rewrite. Prior versions stay in history."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onCancel}
          disabled={submitting}
          aria-label="Close"
          className="-mr-1 -mt-1 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X />
        </Button>
      </div>

      {/* Scope summary — only shown when there's nuance beyond the header's total */}
      {(scopeNotes.length > 0 || protectedRows.length > 0) && (
        <div className="px-5 py-2.5 border-b border-border bg-secondary shrink-0 space-y-1">
          {scopeNotes.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {scopeNotes.join(" — ").replace(/^./, (c) => c.toUpperCase())}.
            </p>
          )}
          {protectedRows.length > 0 && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Lock className="size-3 shrink-0" />
              {protectedRows.map((r) => `${r.n} ${r.label}`).join(", ")} skipped — not touched
            </p>
          )}
        </div>
      )}

      {!aiOff && (
      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
        <div className="flex items-baseline justify-between gap-2">
          <Label>Instruction (optional)</Label>
          <span className={`text-[11px] tabular-nums shrink-0 ${instruction.length > INSTRUCTION_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}>
            {instruction.length}/{INSTRUCTION_MAX_LENGTH}
          </span>
        </div>
        <Textarea
          value={instruction}
          autoFocus
          disabled={submitting}
          rows={4}
          maxLength={INSTRUCTION_MAX_LENGTH}
          className="mt-1.5 resize-y"
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitting) onConfirm(instruction.trim()); }}
          placeholder="e.g. Make it shorter and less salesy — multi-line instructions are fine"
        />
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Applied to every draft in this run only — the campaign&apos;s saved AI context is unchanged.
        </p>
      </div>
      )}

      <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border shrink-0">
        <p className="text-[11px] text-muted-foreground">
          Runs in the background — safe to close.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onConfirm(aiOff ? "" : instruction.trim())} disabled={submitting || total === 0}>
            {submitting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {verb} {total}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
