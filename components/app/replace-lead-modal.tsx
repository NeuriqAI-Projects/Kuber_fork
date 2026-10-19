"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, UserPlus, Loader2, AlertTriangle } from "lucide-react";

export interface ReplaceLeadTarget {
  /** campaign_leads.id of the bounced row. */
  campaignLeadId: string;
  bouncedName: string;
  bouncedEmail: string | null;
  companyName: string | null;
  companyWebsite: string | null;
}

interface ReplaceLeadModalProps {
  target: ReplaceLeadTarget;
  submitting?: boolean;
  error?: string;
  onConfirm: (input: { email: string; first_name: string; last_name?: string; title?: string }) => void;
  onCancel: () => void;
}

export function ReplaceLeadModal(props: ReplaceLeadModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(<ReplaceLeadModalInner {...props} />, document.body);
}

function ReplaceLeadModalInner({ target, submitting, error, onConfirm, onCancel }: ReplaceLeadModalProps) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");

  const canSubmit = !submitting && /\S+@\S+\.\S+/.test(email.trim()) && !!firstName.trim();

  function submit() {
    if (!canSubmit) return;
    onConfirm({
      email: email.trim(),
      first_name: firstName.trim(),
      last_name: lastName.trim() || undefined,
      title: title.trim() || undefined,
    });
  }

  const website = (target.companyWebsite ?? "").replace(/^https?:\/\//i, "").replace(/\/$/, "");

  return (
    // Portals over the campaign drawer (a Radix Dialog), which sets
    // pointer-events:none on <body> while open — same treatment as the other
    // modals here or nothing inside is clickable.
    <div data-confirm-dialog-root className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      <div className="absolute inset-0 bg-black/25 dark:bg-black/60" onClick={submitting ? undefined : onCancel} />

      <div className="relative z-10 w-full max-w-lg mx-4 flex flex-col max-h-[90vh] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight">Correct bounced contact</h2>
            <p className="text-[13px] text-muted-foreground mt-1.5">
              <span className="font-medium text-foreground">{target.bouncedName}</span>
              {target.bouncedEmail && <span> ({target.bouncedEmail})</span>} bounced.
              Enter the right address at {target.companyName ?? "this company"} and we&apos;ll write them their email.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel} disabled={submitting}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 text-muted-foreground hover:text-foreground">
            <X />
          </Button>
        </div>

        <div className="px-5 py-2.5 border-b border-border bg-secondary shrink-0">
          <p className="text-[11px] text-muted-foreground">
            Company profile is already enriched — no re-research, no waiting.
            {website && (
              <>
                {" "}
                <a href={`https://${website}`} target="_blank" rel="noopener noreferrer"
                  className="text-primary hover:underline">
                  {website}
                </a>
              </>
            )}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-3">
          <div className="space-y-1.5">
            <Label>
              New email address <span className="text-destructive">*</span>
            </Label>
            <Input
              value={email}
              autoFocus
              disabled={submitting}
              placeholder="name@company.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>
                First name <span className="text-destructive">*</span>
              </Label>
              <Input value={firstName} disabled={submitting} placeholder="Rahul"
                onChange={(e) => setFirstName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input value={lastName} disabled={submitting} placeholder="Sharma"
                onChange={(e) => setLastName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Job title</Label>
            <Input value={title} disabled={submitting} placeholder="Purchase Manager"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            <p className="text-[11px] text-muted-foreground">Optional — helps the AI pitch to the right role.</p>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border shrink-0">
          <p className="text-[11px] text-muted-foreground">
            Updates this contact everywhere — no new lead is created.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!canSubmit}>
              {submitting ? <Loader2 className="animate-spin" /> : <UserPlus />}
              Correct &amp; draft
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
