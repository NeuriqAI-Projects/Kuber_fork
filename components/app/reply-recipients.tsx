"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { EmailChipInput } from "@/components/ui/email-chip-input";
import { cn } from "@/lib/utils";

/**
 * One line of the reply composer: a short muted label on the left ("To",
 * "Subject", "Cc") and the field on the right, Gmail/Attio style.
 */
export function ComposerRow({
  label,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[52px_minmax(0,1fr)] items-start gap-x-2", className)}>
      <Label htmlFor={htmlFor} className="pt-2 text-[13px] font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The To line of a reply — editable, except for one address.
 *
 * Instantly's POST /emails/reply has no To field. It always addresses the sender
 * of `reply_to_uuid`, and everything else we ask for rides along in
 * `additional_recipients` (which land in To, not CC). So exactly one chip here
 * is immovable: to change WHO that is, you reply to a different message. The
 * lock icon says that out loud rather than letting someone click a remove
 * button that quietly does nothing.
 *
 * Raw addresses on purpose, never display names: the composer used to caption
 * every reply "to <the lead>" while Instantly addressed it to whoever wrote
 * last, so a reply could leave the prospect off their own thread with nothing
 * on screen admitting it. A friendly label is the abstraction that hid that.
 */
export function ReplyToField({
  to,
  onChange,
  lockedTo,
  suggestions,
  disabled,
}: {
  to: string[];
  onChange: (next: string[]) => void;
  /** Forced by reply_to_uuid — rendered locked, never removable. */
  lockedTo: string | null;
  suggestions: string[];
  disabled?: boolean;
}) {
  const missing = suggestions.filter((s) => !to.includes(s));

  return (
    <ComposerRow label="To">
      <EmailChipInput
        emails={to}
        onChange={onChange}
        disabled={disabled}
        allowAdd={false}
        lockedEmail={lockedTo}
        lockedTitle="Instantly always addresses the message you are replying to. Reply to a different message to change this."
        emptyText="No recipient — nobody has replied to this thread yet"
      />
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          <span className="text-xs text-muted-foreground">Also on this thread:</span>
          {missing.map((email) => (
            <button
              key={email}
              type="button"
              disabled={disabled}
              onClick={() => onChange([...to, email])}
              className="rounded-[5px] border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50"
            >
              + {email}
            </button>
          ))}
        </div>
      )}
    </ComposerRow>
  );
}

/** Warns when the campaign's lead is not among the people this reply reaches. */
export function LeadExcludedWarning({
  to,
  cc,
  bcc,
  leadEmail,
  leadName,
}: {
  to: string[];
  cc: string[];
  bcc: string[];
  leadEmail: string | null;
  leadName: string;
}) {
  const lead = leadEmail?.trim().toLowerCase() ?? null;
  const reaches = new Set([...to, ...cc, ...bcc].map((e) => e.trim().toLowerCase()));
  if (!lead || reaches.has(lead)) return null;

  return (
    <p className="ml-[60px] flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>
        {leadName} ({leadEmail}) will <strong className="font-semibold">not</strong> receive this reply.
      </span>
    </p>
  );
}
