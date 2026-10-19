"use client";

import { ExternalLink } from "lucide-react";
import { Tip } from "@/components/ui/tip";

/** A domain (or any short link text) that stays on one line: cut with "…" only when it does not
 *  fit its column, full text on hover. The whole thing (text and icon) is a link that opens in a new tab
 *  and turns blue on hover.
 *  One component so the organization list and the scored-companies list look the same. */
export function DomainLink({ text, href, tip = "Open website in a new tab." }: { text: string | null; href?: string | null; tip?: string }) {
  if (!text) return <span className="font-mono text-xs text-muted-foreground">—</span>;
  const url = href ?? (/^https?:\/\//i.test(text) ? text : `https://${text}`);
  return (
    <Tip text={tip} block>
      <a
        href={url} target="_blank" rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary"
      >
        <span className="min-w-0 truncate font-mono text-xs" title={text}>{text}</span>
        <ExternalLink className="size-3.5 shrink-0" />
      </a>
    </Tip>
  );
}
