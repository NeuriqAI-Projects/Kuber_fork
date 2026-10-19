"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Lock, X } from "lucide-react";
import { cn } from "@/lib/utils";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Address field for To / Cc / Bcc: each address is a removable chip in a box
 * styled like `Input`. Typing an address and pressing Enter, comma or Tab (or
 * leaving the field) adds it; Backspace on an empty draft removes the last
 * chip. `suggestions` open a picker under the field.
 *
 * `lockedEmail` renders that one chip tinted with a lock instead of a remove
 * button — for an address the provider forces (Instantly always replies to the
 * sender of the message being answered). `allowAdd={false}` hides the typing
 * target, for a field you can only prune.
 */
export function EmailChipInput({
  emails,
  onChange,
  disabled,
  suggestions = [],
  allowAdd = true,
  lockedEmail,
  lockedTitle,
  emptyText,
  placeholder = "Add email, press Enter",
  max,
  onError,
}: {
  emails: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  suggestions?: string[];
  allowAdd?: boolean;
  lockedEmail?: string | null;
  /** Tooltip on the locked chip, saying why it can't be removed. */
  lockedTitle?: string;
  /** Shown in the box when there are no chips and no typing target. */
  emptyText?: ReactNode;
  placeholder?: string;
  /** Most addresses the field accepts. */
  max?: number;
  /** A typed address was refused (bad format, over `max`); null once it's fine again. */
  onError?: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
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
        onError?.(`Invalid email: ${part}`);
        return;
      }
      if (next.includes(e)) continue;
      if (max != null && next.length >= max) {
        onError?.(`At most ${max} addresses`);
        return;
      }
      next.push(e);
    }
    onError?.(null);
    setDraft("");
    setOpen(false);
    onChange(next);
  }

  function pickSuggestion(email: string) {
    if (emails.includes(email) || (max != null && emails.length >= max)) return;
    onChange([...emails, email]);
    setDraft("");
    setOpen(false);
    onError?.(null);
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
      const last = emails[emails.length - 1];
      if (last !== lockedEmail) onChange(emails.slice(0, -1));
    }
  }

  const suggestionsKey = suggestions.join("|");
  const emailsKey = emails.join("|");
  useEffect(() => {
    setActiveIdx(0);
  }, [draft, suggestionsKey, emailsKey]);

  useEffect(() => {
    if (!allowAdd) return;
    function onDoc(ev: MouseEvent) {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [allowAdd]);

  return (
    <div className="relative" ref={wrapRef}>
      <div
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-field px-1.5 py-1 shadow-xs",
          disabled && "opacity-50 pointer-events-none",
        )}
      >
        {emails.length === 0 && !allowAdd && emptyText && (
          <span className="px-1 text-[13px] text-muted-foreground">{emptyText}</span>
        )}
        {emails.map((email) => {
          const locked = email === lockedEmail;
          return (
            <span
              key={email}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs leading-4 text-foreground",
                locked ? "bg-primary/10" : "bg-secondary",
              )}
              title={locked ? lockedTitle : undefined}
            >
              <span className="truncate">{email}</span>
              {locked ? (
                <Lock className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(emails.filter((x) => x !== email))}
                  className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${email}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          );
        })}
        {allowAdd && (
          <input
            type="email"
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              onError?.(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Delay so a suggestion click can fire first.
              window.setTimeout(() => {
                if (draft.trim() && !wrapRef.current?.contains(document.activeElement)) {
                  commit(draft);
                }
              }, 120);
            }}
            placeholder={emails.length === 0 ? placeholder : ""}
            className="h-6 min-w-40 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground/80"
            autoComplete="off"
          />
        )}
      </div>
      {allowAdd && open && filtered.length > 0 && (
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
  );
}
