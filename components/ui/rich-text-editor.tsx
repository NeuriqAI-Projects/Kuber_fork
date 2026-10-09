"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { markdownInlineToHtml, convertResidualMarkdownInHtml } from "@/lib/utils/email-html";

export interface TemplateVar {
  /** Inserted as {{token}} — must match what the reading code substitutes
   *  (see e.g. lib/services/followup-template.ts's fillFollowupTemplate),
   *  not a display convention chosen here. Get this wrong and the pill looks
   *  right in the editor but sends the literal "{{token}}" text. */
  token: string;
  /** Shown on the toolbar pill itself. */
  label: string;
  /** Shown in the hover tooltip, above the example. */
  description: string;
  example?: string;
}

// Generic tooltip text for any {{token}} the highlighter finds, even one a
// caller didn't declare via templateVars (e.g. typed by hand, or left over
// from a different field's convention) — better than no explanation at all.
const TEMPLATE_VAR_TOOLTIPS: Record<string, string> = {
  first_name: "Lead's first name · e.g. \"John\"",
  last_name:  "Lead's last name · e.g. \"Doe\"",
  name:       "Lead's first name · e.g. \"John\"",
  company:    "Lead's company · e.g. \"Acme Inc.\"",
  firstName:  "Lead's first name · e.g. \"John\"",
  lastName:   "Lead's last name · e.g. \"Doe\"",
  senderName: "Your name · e.g. \"Kavish\"",
  email:      "Lead's email · e.g. \"john@acme.com\"",
};

const TemplateVarHighlight = Extension.create({
  name: "templateVarHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("templateVarHighlight"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const regex = /\{\{([^}]+)\}\}/g;
              let match;
              while ((match = regex.exec(node.text)) !== null) {
                const varName = match[1];
                const title = TEMPLATE_VAR_TOOLTIPS[varName] ?? "Template variable";
                decorations.push(
                  Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
                    class: "tpl-var-chip",
                    title,
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
import {
  Bold, Italic, Underline as UnderlineIcon,
  List, ListOrdered, Link as LinkIcon, Unlink,
  Heading2, Copy, Table2, BetweenHorizontalStart, BetweenVerticalStart, Trash2,
} from "lucide-react";

function normalizeToHtml(raw: string): string {
  if (!raw) return "";
  // Already block-level HTML (saved by TipTap on a previous edit) — safety net
  // for residual markdown markers, otherwise return as-is.
  if (/^\s*<(p|div|ul|ol|table|h[1-6])\b/i.test(raw)) return convertResidualMarkdownInHtml(raw);
  // Plain text (possibly with **bold** markers): match Gmail's rendering exactly.
  // Escape entities first, then convert **bold** → <strong>, then newlines → <br>.
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    "<p>" +
    markdownInlineToHtml(escaped)
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>") +
    "</p>"
  );
}

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  /** Toolbar pills for inserting {{token}} placeholders — e.g. a lead's first
   *  name or company. Omit for no pills; pass the tokens the reading code on
   *  the other end actually substitutes (see the TemplateVar doc comment). */
  templateVars?: TemplateVar[];
  /** Show the "insert table" controls (stored as plain HTML <table>, which is
   *  what Instantly sends). On everywhere by default — every email editor in
   *  the app is this component, so they all behave the same. */
  tables?: boolean;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={cn(
        "transition-colors",
        active
          ? "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary",
      )}
    >
      {children}
    </Button>
  );
}

// Draft bodies can contain an HTML table when "HTML emails" is on in Settings.
// StarterKit has no table node, so without this the first edit of such a draft
// would silently flatten it to text. The three presentational attributes are
// kept because they are what gives the table its grid in an email client.
// Tables are never created from the toolbar - only preserved.
const EmailTable = Table.extend({
  addAttributes() {
    const keep = (name: string) => ({
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(name),
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [name]: attrs[name] as string } : {}),
    });
    return {
      ...this.parent?.(),
      // Defaults so a table inserted from the toolbar gets the same grid the
      // AI-written ones carry (and survives Tailwind-less mail clients).
      border: { ...keep("border"), default: "1" },
      cellpadding: { ...keep("cellpadding"), default: "8" },
      cellspacing: { ...keep("cellspacing"), default: "0" },
    };
  },
});

export function RichTextEditor({
  value,
  onChange,
  disabled = false,
  placeholder = "Write your email…",
  className,
  minHeight = 280,
  templateVars,
  tables = true,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        code: false,
        blockquote: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-blue-400 underline" },
      }),
      Placeholder.configure({ placeholder }),
      TemplateVarHighlight,
      EmailTable,
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: normalizeToHtml(value),
    editable: !disabled,
    onUpdate({ editor }) {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "outline-none",
      },
    },
  });

  // Sync external value changes (e.g. switching leads)
  useEffect(() => {
    if (!editor) return;
    const normalized = normalizeToHtml(value);
    if (editor.getHTML() !== normalized) {
      editor.commands.setContent(normalized, { emitUpdate: false });
    }
  }, [editor, value]);

  // Sync disabled prop
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  function addLink() {
    const url = window.prompt("Enter URL");
    if (!url) return;
    editor?.chain().focus().setLink({ href: url }).run();
  }

  if (!editor) return null;

  return (
    <div className={cn("rounded-md border border-border bg-field", className)}>
      {/* Toolbar. No overflow-hidden on the outer wrapper (above) any more —
          it was clipping the {{token}} chip tooltips below, which sit right at
          the toolbar's edge. Rounding is done per-piece instead. */}
      <div className={cn(
        "flex items-center gap-0.5 rounded-t-md border-b border-border bg-secondary px-2 py-1 flex-wrap",
        disabled && "opacity-50 pointer-events-none",
      )}>
        <span className="eyebrow inline-flex h-7 items-center gap-1.5 px-1 mr-0.5">
          <Bold className="size-3" /> Format
        </span>
        <div className="w-px h-4 bg-border mx-1" />

        <ToolbarButton
          title="Bold"
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive("bold")}
          disabled={disabled}
        >
          <Bold className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Italic"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive("italic")}
          disabled={disabled}
        >
          <Italic className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive("underline")}
          disabled={disabled}
        >
          <UnderlineIcon className="size-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        <ToolbarButton
          title="Heading"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive("heading", { level: 2 })}
          disabled={disabled}
        >
          <Heading2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")}
          disabled={disabled}
        >
          <List className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")}
          disabled={disabled}
        >
          <ListOrdered className="size-3.5" />
        </ToolbarButton>

        {tables && (
          <>
            <div className="w-px h-4 bg-border mx-1" />
            <ToolbarButton
              title="Insert table"
              onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
              disabled={disabled || editor.isActive("table")}
            >
              <Table2 className="size-3.5" />
            </ToolbarButton>
            {editor.isActive("table") && (
              <>
                <ToolbarButton title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()} disabled={disabled}>
                  <BetweenHorizontalStart className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()} disabled={disabled}>
                  <BetweenVerticalStart className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()} disabled={disabled}>
                  <span className="text-[10px] font-semibold">−Row</span>
                </ToolbarButton>
                <ToolbarButton title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()} disabled={disabled}>
                  <span className="text-[10px] font-semibold">−Col</span>
                </ToolbarButton>
                <ToolbarButton title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()} disabled={disabled}>
                  <Trash2 className="size-3.5" />
                </ToolbarButton>
              </>
            )}
          </>
        )}

        <div className="w-px h-4 bg-border mx-1" />

        <ToolbarButton title="Add link" onClick={addLink} disabled={disabled}>
          <LinkIcon className="size-3.5" />
        </ToolbarButton>
        {editor.isActive("link") && (
          <ToolbarButton
            title="Remove link"
            onClick={() => editor.chain().focus().unsetLink().run()}
            disabled={disabled}
          >
            <Unlink className="size-3.5" />
          </ToolbarButton>
        )}

        {templateVars && templateVars.length > 0 && (
          <>
            <div className="w-px h-4 bg-border mx-1" />

            {templateVars.map((v) => (
              <div key={v.token} className="relative group">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    editor.chain().focus().insertContent(`{{${v.token}}}`).run();
                  }}
                  className="h-6 gap-1 rounded px-1.5 py-0.5 bg-primary/15 text-primary text-[11px] font-mono font-semibold border border-primary/25 hover:bg-primary/25 hover:text-primary"
                >
                  {v.label}
                  <Copy className="size-2.5 opacity-60" />
                </Button>
                <div className="pointer-events-none absolute top-full right-0 mt-1.5 z-50 w-48 rounded-md bg-popover border border-border shadow-lg px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-xs font-semibold text-foreground">{v.description}</p>
                  {v.example && <p className="text-[11px] text-muted-foreground mt-0.5">e.g. &quot;{v.example}&quot;</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">Type <span className="font-mono bg-muted px-0.5 rounded">{`{{${v.token}}}`}</span> or click to insert</p>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Editor content */}
      <EditorContent
        editor={editor}
        style={{ minHeight }}
        className={cn(
          "px-4 py-3 text-sm leading-relaxed",
          "[&_.ProseMirror]:outline-none",
          "[&_.ProseMirror]:min-h-[inherit]",
          "[&_.ProseMirror_p]:mt-0 [&_.ProseMirror_p]:mb-[1em]",
          "[&_.ProseMirror_h2]:text-base [&_.ProseMirror_h2]:font-bold [&_.ProseMirror_h2]:mt-3 [&_.ProseMirror_h2]:mb-1",
          "[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ul]:my-1",
          "[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_ol]:my-1",
          "[&_.ProseMirror_li]:my-0.5",
          "[&_.ProseMirror_table]:border-collapse [&_.ProseMirror_table]:my-2",
          "[&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-2 [&_.ProseMirror_td]:py-1 [&_.ProseMirror_td_p]:mb-0",
          "[&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:px-2 [&_.ProseMirror_th]:py-1 [&_.ProseMirror_th]:text-left [&_.ProseMirror_th_p]:mb-0",
          "[&_.ProseMirror_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
          "[&_.ProseMirror_.is-editor-empty:first-child::before]:text-muted-foreground",
          "[&_.ProseMirror_.is-editor-empty:first-child::before]:float-left",
          "[&_.ProseMirror_.is-editor-empty:first-child::before]:pointer-events-none",
          "[&_.ProseMirror_.is-editor-empty:first-child::before]:h-0",
          "[&_.tpl-var-chip]:bg-primary/15 [&_.tpl-var-chip]:text-primary [&_.tpl-var-chip]:rounded [&_.tpl-var-chip]:px-1.5 [&_.tpl-var-chip]:py-0.5 [&_.tpl-var-chip]:text-xs [&_.tpl-var-chip]:font-mono [&_.tpl-var-chip]:font-semibold [&_.tpl-var-chip]:border [&_.tpl-var-chip]:border-primary/25 [&_.tpl-var-chip]:cursor-help",
          disabled && "opacity-60",
        )}
      />
    </div>
  );
}
