"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Bold, Italic, Underline, List, ListOrdered, Undo2, Redo2, Eraser, Link2, Type } from "lucide-react";

/**
 * The prompt editor used wherever someone writes instructions for the AI —
 * Settings > AI & Outreach, and Model Lab.
 *
 * Deliberately NOT components/ui/rich-text-editor.tsx, which stores real HTML
 * for an email body. A prompt is stored as TEXT with markdown-ish markers, so
 * this one round-trips through textToHtml/htmlToText: what the model receives
 * is exactly what is stored, and the toolbar is a convenience over that text.
 *
 * Extracted from settings-view.tsx when Model Lab needed the same control. Per
 * CLAUDE.md there is one shared component per control type; a second local copy
 * here is the bug that rule exists to prevent.
 */

type EditorCommand = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList" | "undo" | "redo" | "removeFormat";

export function textToHtml(value: string) {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br />"))
    .map((p) => `<p>${p || "<br />"}</p>`)
    .join("");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function PromptEditor({
  label, value, onChange, placeholder, minHeight = 240, helper, singleLineBreaks = false,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; minHeight?: number; helper?: string;
  /** Enter inserts a line break instead of a paragraph. For sign-off blocks. */
  singleLineBreaks?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedValue = useRef<string | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;
    const current = htmlToText(editorRef.current.innerHTML);
    if (lastSyncedValue.current === value && current === value) return;
    editorRef.current.innerHTML = textToHtml(value);
    lastSyncedValue.current = value;
  }, [value]);

  function syncValue() {
    const next = htmlToText(editorRef.current?.innerHTML ?? "").replace(/\n{3,}/g, "\n\n").trimEnd();
    lastSyncedValue.current = next;
    onChange(next);
  }

  function runCommand(cmd: EditorCommand) { editorRef.current?.focus(); document.execCommand(cmd); syncValue(); }

  // contentEditable's Enter starts a new paragraph, which htmlToText writes out
  // as a blank line between every entry. Correct for a prompt, wrong for a
  // sign-off block, where the name, title and contact lines belong on
  // consecutive lines. Users were left choosing between a blank line (Enter)
  // and no break at all (backspace, which merges the paragraphs and runs the
  // lines together); the single break needed Shift+Enter, which nobody guesses.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!singleLineBreaks || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    document.execCommand("insertLineBreak");
    syncValue();
  }

  function addLink() {
    editorRef.current?.focus();
    const url = window.prompt("Paste a URL");
    if (url) { document.execCommand("createLink", false, url); syncValue(); }
  }

  const toolbar = [
    { label: "Bold",           icon: Bold,         command: "bold" as const },
    { label: "Italic",         icon: Italic,        command: "italic" as const },
    { label: "Underline",      icon: Underline,     command: "underline" as const },
    { label: "Bulleted list",  icon: List,          command: "insertUnorderedList" as const },
    { label: "Numbered list",  icon: ListOrdered,   command: "insertOrderedList" as const },
    { label: "Undo",           icon: Undo2,         command: "undo" as const },
    { label: "Redo",           icon: Redo2,         command: "redo" as const },
    { label: "Clear formatting", icon: Eraser,      command: "removeFormat" as const },
  ];

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {/* bg-field, not bg-card: this IS a field — someone types their prompt
          into it — and in light mode card is the same grey as the page, so the
          editor dissolved into the panel behind it. Its sibling
          rich-text-editor.tsx already had this right. */}
      <div className="overflow-hidden rounded-md border border-border bg-field">
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-secondary px-2 py-1">
          <span className="eyebrow inline-flex h-7 items-center gap-1.5 px-1">
            <Type className="size-3" /> Compose
          </span>
          <div className="mx-1 h-4 w-px bg-border" />
          {toolbar.map(({ label: lbl, icon: Icon, command }) => (
            <Button key={command} type="button" variant="ghost" size="icon-sm" aria-label={lbl} title={lbl}
              onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(command)}
              className="text-muted-foreground hover:text-foreground">
              <Icon className="size-3.5" />
            </Button>
          ))}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Add link" title="Add link"
            onMouseDown={(e) => e.preventDefault()} onClick={addLink}
            className="text-muted-foreground hover:text-foreground">
            <Link2 className="size-3.5" />
          </Button>
        </div>
        <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true"
          contentEditable suppressContentEditableWarning data-placeholder={placeholder}
          onInput={syncValue} onBlur={syncValue} onKeyDown={handleKeyDown}
          className="rich-editor min-w-0 bg-field px-4 py-3 text-sm leading-6 text-foreground outline-none"
          style={{ minHeight }} />
      </div>
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  );
}
