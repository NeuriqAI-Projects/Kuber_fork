/**
 * The one place email bodies cross between HTML (what we store and send) and
 * plain text (what the model reads and writes).
 *
 * These two functions MUST be exact inverses. They were not: plainToHtml turned
 * `**bold**` into <strong>, but htmlToPlainText had no rule for <strong> — it
 * fell through to the catch-all tag strip. So every regenerate silently flattened
 * the draft:
 *
 *     stored   <strong>Ankit Singh</strong>
 *     -> model sees   Ankit Singh          (markers gone)
 *     -> saved as     Ankit Singh          (never bold again)
 *
 * Unrecoverable, and worse on each pass. The same held for <em>, <u> and links —
 * <a href="...">brochure</a> kept the word and threw the URL away.
 *
 * Two copies of htmlToPlainText existed (generate-drafts and generate-reply),
 * both with the bug. One copy now, so an inverse rule can never be added to one
 * side and forgotten on the other.
 */

/**
 * Convert markdown-ish inline markers to HTML tags. Input must already be
 * HTML-entity-escaped. Shared by every place that turns plain/markdown text
 * (model output, settings signatures, reply signatures) into HTML, so a
 * fix to how `**bold**` is recognised never has to be duplicated.
 */
export function markdownInlineToHtml(escaped: string): string {
  return escaped
    // Links first: their label may itself be bold/italic.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // ** before * — otherwise `**x**` matches the italic rule and yields `<em>*x*</em>`.
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/**
 * Convert residual markdown-ish markers (`**bold**`, `__underline__`, `*italic*`)
 * that ended up stored INSIDE real HTML — e.g. a signature appended through a
 * path that escaped text but never ran the `**` → `<strong>` conversion (see
 * `signatureToHtml` history). Only text nodes are touched; tags/attributes pass
 * through untouched, so this is safe to run on any already-HTML content, not
 * just freshly authored drafts. Cheap no-op when there is nothing to convert.
 *
 * Some legacy signatures had a mismatched (odd) count of `**` markers, so a
 * previous conversion pass already turned the pairs that DID line up into
 * `<strong>`, leaving genuinely unpairable `**`/`***`/`****` runs stranded next
 * to (or inside) those tags — e.g. `<strong>**Business Head</strong>**(NA)`.
 * Those can never become a valid pair, so after converting whatever pairs
 * remain, any leftover run of 2+ asterisks is stripped rather than shown
 * literally — legitimate prose essentially never contains "**".
 */
export function convertResidualMarkdownInHtml(html: string): string {
  if (!html || !/[*_]/.test(html)) return html;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_match, tag?: string, text?: string) => {
    if (tag !== undefined) return tag;
    return markdownInlineToHtml(text ?? "").replace(/\*{2,}/g, "");
  });
}

/** Markdown-ish plain text (what the model writes) -> HTML (what we store/send). */
export function plainToHtml(plain: string): string {
  const escaped = plain
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

/** HTML -> markdown-ish plain text. The exact inverse of plainToHtml. */
/**
 * Does this HTML carry any text a reader would see?
 *
 * An emptied rich-text box does not store "" — it stores "<p></p>", which is a
 * non-empty string and therefore passed every `?.trim()` truthiness check we
 * had. In the follow-up fallback ladder that meant an empty box BEAT the
 * company default it was supposed to fall through to, and the step resolved to
 * an email with no body (PACKAGING GROUP 1 step 3, caught 18 Sep before
 * anything sent). Anywhere a blank box must mean "not set", ask this, not
 * `.trim()`.
 */
export function hasVisibleText(html: string | null | undefined): boolean {
  return htmlToPlainText(html ?? "").replace(/\s/g, "") !== "";
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    // Formatting -> markers, BEFORE the catch-all strip below eats the tags.
    // Without these three lines the model never sees that anything was
    // formatted, so it cannot preserve it and every regenerate loses it.
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, "__$1__")
    // Keep the URL, not just the label — a regenerated draft used to keep the
    // word "brochure" and lose the download link behind it.
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
