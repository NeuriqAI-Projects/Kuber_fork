"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fetchReplyMailingList } from "@/lib/api-client";
import { EMAIL_RE, EmailChipInput } from "@/components/ui/email-chip-input";
import { ComposerRow } from "@/components/app/reply-recipients";

const MAX_PER_LIST = 10;

export function normalizeReplyEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (!e || !EMAIL_RE.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= MAX_PER_LIST) break;
  }
  return out;
}

/** Rejects overlap between CC and BCC; returns an error message or null. */
export function validateCcBcc(cc: string[], bcc: string[]): string | null {
  const ccN = normalizeReplyEmails(cc);
  const bccN = normalizeReplyEmails(bcc);
  if (ccN.length > MAX_PER_LIST || bccN.length > MAX_PER_LIST) {
    return `At most ${MAX_PER_LIST} addresses per CC / BCC list`;
  }
  const ccSet = new Set(ccN);
  if (bccN.some((e) => ccSet.has(e))) {
    return "An address cannot be in both CC and BCC";
  }
  return null;
}

function EmailChipList({
  label,
  emails,
  onChange,
  disabled,
  helper,
  suggestions,
}: {
  label: string;
  emails: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  helper: string;
  suggestions: string[];
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <ComposerRow label={label}>
      <EmailChipInput
        emails={emails}
        onChange={onChange}
        disabled={disabled}
        suggestions={suggestions}
        max={MAX_PER_LIST}
        onError={setError}
      />
      <p className="pt-1 text-xs text-muted-foreground">{helper}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </ComposerRow>
  );
}

export function ReplyCcBccFields({
  token,
  cc,
  bcc,
  onCcChange,
  onBccChange,
  disabled,
}: {
  token: string;
  cc: string[];
  bcc: string[];
  onCcChange: (next: string[]) => void;
  onBccChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [showCc, setShowCc] = useState(cc.length > 0);
  const [showBcc, setShowBcc] = useState(bcc.length > 0);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const loadSuggestions = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetchReplyMailingList(token, { limit: 40 });
      setSuggestions(res.emails ?? []);
    } catch {
      /* non-fatal — composer still works without suggestions */
    }
  }, [token]);

  useEffect(() => {
    if (showCc || showBcc) void loadSuggestions();
  }, [showCc, showBcc, loadSuggestions]);

  useEffect(() => {
    if (cc.length > 0) setShowCc(true);
  }, [cc.length]);
  useEffect(() => {
    if (bcc.length > 0) setShowBcc(true);
  }, [bcc.length]);

  return (
    <div className="space-y-2">
      {(!showCc || !showBcc || (cc.length === 0 && bcc.length === 0)) && (
        <div className="ml-[60px] flex items-center gap-0.5">
          {!showCc && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setShowCc(true)} className="-ml-2 px-2 text-muted-foreground">
              Cc
            </Button>
          )}
          {!showBcc && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setShowBcc(true)} className={cn("px-2 text-muted-foreground", showCc && "-ml-2")}>
              Bcc
            </Button>
          )}
          {(showCc || showBcc) && cc.length === 0 && bcc.length === 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setShowCc(false);
                setShowBcc(false);
              }}
              className="ml-auto px-2 text-muted-foreground"
            >
              Hide
            </Button>
          )}
        </div>
      )}

      {(showCc || showBcc) && (
        <div className="space-y-2">
          {showCc && (
            <EmailChipList
              label="Cc"
              emails={cc}
              onChange={onCcChange}
              disabled={disabled}
              helper="Visible to the recipient."
              suggestions={suggestions}
            />
          )}
          {showBcc && (
            <EmailChipList
              label="Bcc"
              emails={bcc}
              onChange={onBccChange}
              disabled={disabled}
              helper="Hidden from the recipient."
              suggestions={suggestions}
            />
          )}
        </div>
      )}
    </div>
  );
}
