"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fetchReplyMailingList } from "@/lib/api-client";
import { chipClass, chipFieldClass, ComposerRow } from "@/components/app/reply-recipients";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const filtered = (() => {
    const q = draft.trim().toLowerCase();
    const taken = new Set(emails);
    return suggestions
      .filter((e) => !taken.has(e) && (!q || e.includes(q)))
      .slice(0, 8);
  })();

  function commit(raw: string) {
    const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...emails];
    for (const part of parts) {
      const e = part.toLowerCase();
      if (!EMAIL_RE.test(e)) {
        setError(`Invalid email: ${part}`);
        return;
      }
      if (next.includes(e)) continue;
      if (next.length >= MAX_PER_LIST) {
        setError(`At most ${MAX_PER_LIST} addresses`);
        return;
      }
      next.push(e);
    }
    setError(null);
    setDraft("");
    setOpen(false);
    onChange(next);
  }

  function pickSuggestion(email: string) {
    if (emails.includes(email) || emails.length >= MAX_PER_LIST) return;
    onChange([...emails, email]);
    setDraft("");
    setOpen(false);
    setError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && filtered.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActiveIdx((i) => {
        if (e.key === "ArrowDown") return (i + 1) % filtered.length;
        return (i - 1 + filtered.length) % filtered.length;
      });
      return;
    }
    if (e.key === "Enter" && open && filtered[activeIdx]) {
      e.preventDefault();
      pickSuggestion(filtered[activeIdx]);
      return;
    }
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (!draft.trim()) return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !draft && emails.length > 0) {
      onChange(emails.slice(0, -1));
    }
  }

  useEffect(() => {
    setActiveIdx(0);
  }, [draft, suggestions.join("|"), emails.join("|")]);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <ComposerRow label={label}>
      <div className="relative" ref={wrapRef}>
        <div className={cn(chipFieldClass, disabled && "opacity-50 pointer-events-none")}>
          {emails.map((email) => (
            <span key={email} className={cn(chipClass, "bg-secondary text-foreground")}>
              <span className="truncate">{email}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(emails.filter((x) => x !== email))}
                className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${email}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {/* eslint-disable-next-line no-restricted-syntax -- bare typing target inside the recipient-chips field; the chips row is the visible control */}
          <input
            type="email"
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Delay so suggestion click can fire first.
              window.setTimeout(() => {
                if (draft.trim() && !wrapRef.current?.contains(document.activeElement)) {
                  commit(draft);
                }
              }, 120);
            }}
            placeholder={emails.length === 0 ? "Add email, press Enter" : ""}
            className="h-6 min-w-40 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground/80"
            autoComplete="off"
          />
        </div>
        {open && filtered.length > 0 && (
          <ul
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
            role="listbox"
          >
            {filtered.map((email, i) => (
              <li key={email}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  className={cn(
                    "flex h-8 w-full items-center rounded-md px-2 text-left text-[13px] text-foreground",
                    i === activeIdx ? "bg-hover" : "hover:bg-hover",
                  )}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pickSuggestion(email);
                  }}
                >
                  {email}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
