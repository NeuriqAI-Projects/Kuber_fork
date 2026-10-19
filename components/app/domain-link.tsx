"use client";

import { ExternalLink } from "lucide-react";
import { Tip } from "@/components/ui/tip";

/** A domain (or any short link text) that stays on one line: cut with "…" only when it does not
 *  fit its column, full text on hover, and a small icon that opens the page in a new tab.
 *  One component so the organization list and the scored-companies list look the same. */
export function DomainLink({ text, href, tip = "Open website in a new tab." }: { text: string | null; href?: string | null; tip?: string }) {
  if (!text) return <span className="font-mono text-xs text-muted-foreground">—</span>;
  const url = href ?? (/^https?:\/\//i.test(text) ? text : `https://${text}`);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={text}>{text}</span>
      <Tip text={tip}>
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-muted-foreground hover:text-primary">
          <ExternalLink className="size-3.5" />
        </a>
      </Tip>
    </div>
  );
}
