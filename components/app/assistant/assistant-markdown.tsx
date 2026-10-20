"use client";

// A small, safe Markdown renderer for assistant answers.
//
// The model writes a known subset: paragraphs, **bold**, *italic*, `code`,
// [links](/leads/…), bullet and numbered lists, ### headings and pipe tables.
// Rendering it ourselves keeps a Markdown library out of the bundle and — more
// important — never injects HTML: every piece of text goes through React, so a
// lead's name or an email quote can't become markup.
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { parseMarkdown } from "@/lib/assistant-markdown";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function renderInline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith("**")) out.push(<strong key={k} className="font-semibold text-foreground">{renderInline(tok.slice(2, -2), k)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-secondary px-1 py-0.5 text-[12px]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? "#";
      if (href.startsWith("/")) {
        out.push(<Link key={k} href={href} className="text-primary hover:underline underline-offset-2">{label}</Link>);
      } else if (/^https?:\/\//.test(href)) {
        out.push(<a key={k} href={href} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline underline-offset-2">{label}</a>);
      } else {
        out.push(label);
      }
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((line, i) => (i === 0 ? renderInline(line, `${key}l${i}`) : [<br key={`${key}br${i}`} />, ...renderInline(line, `${key}l${i}`)]));
}

export function AssistantMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={cn("space-y-2 text-[13.5px] leading-relaxed text-foreground/90 break-words", className)}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case "p":
            return <p key={k}>{withBreaks(b.text, k)}</p>;
          case "h":
            return <p key={k} className={cn("font-semibold text-foreground", b.level <= 2 ? "text-[14px] pt-1" : "text-[13.5px]")}>{renderInline(b.text, k)}</p>;
          case "ul":
          case "ol": {
            const List = b.type === "ul" ? "ul" : "ol";
            return (
              <List key={k} className={cn("space-y-1 pl-4", b.type === "ul" ? "list-disc marker:text-muted-foreground/60" : "list-decimal marker:text-muted-foreground")}>
                {b.items.map((item, j) => <li key={`${k}i${j}`} className="pl-0.5">{renderInline(item, `${k}i${j}`)}</li>)}
              </List>
            );
          }
          case "table":
            return (
              <div key={k} className="overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead className="bg-secondary">
                    <tr>
                      {b.head.map((c, j) => <th key={j} className="border-b border-border px-2.5 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">{renderInline(c, `${k}h${j}`)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border last:border-0">
                        {row.map((c, j) => <td key={j} className="px-2.5 py-1.5 align-top tabular-nums">{renderInline(c, `${k}r${r}c${j}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "code":
            return <pre key={k} className="overflow-x-auto rounded-md bg-secondary px-3 py-2 text-[12px]">{b.text}</pre>;
          case "hr":
            return <hr key={k} className="border-border" />;
          default:
            return <Fragment key={k} />;
        }
      })}
    </div>
  );
}
