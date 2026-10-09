import sanitizeHtml from "sanitize-html";
import { plainToHtml, convertResidualMarkdownInHtml, collapseTableWhitespace } from "@/lib/utils/email-html";

/**
 * Server-only (sanitize-html is too heavy for the client bundle, which is why
 * this is not in email-html.ts). Used only when the "HTML emails" setting is on.
 *
 * The model writes plain text with, on explicit request, a raw <table> block
 * (Instantly renders tables from HTML). Everything outside the table goes
 * through plainToHtml unchanged; the table is sanitised to a small allow-list
 * and spliced in between — never inside a <p>, which is invalid HTML.
 */
const TABLE_BLOCK = /<table\b[\s\S]*?<\/table>/gi;

function cleanTable(raw: string): string {
  const clean = sanitizeHtml(raw, {
    allowedTags: ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "strong", "b", "em", "i", "u", "br", "a"],
    allowedAttributes: {
      table: ["border", "cellpadding", "cellspacing", "width", "align"],
      th: ["colspan", "rowspan", "align", "width"],
      td: ["colspan", "rowspan", "align", "width"],
      a: ["href", "target", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    // A model that forgot the attributes still gets a readable grid.
    transformTags: {
      table: (tag, attribs) => ({
        tagName: tag,
        attribs: { border: "1", cellpadding: "8", cellspacing: "0", ...attribs },
      }),
    },
  });
  return collapseTableWhitespace(convertResidualMarkdownInHtml(clean)).trim();
}

export function plainToHtmlWithTables(plain: string): string {
  if (!/<table\b/i.test(plain)) return plainToHtml(plain);

  const out: string[] = [];
  const pushText = (seg: string) => { if (seg.trim()) out.push(plainToHtml(seg.trim())); };
  let last = 0;
  for (const m of plain.matchAll(TABLE_BLOCK)) {
    pushText(plain.slice(last, m.index));
    const table = cleanTable(m[0]);
    if (table) out.push(table);
    last = (m.index ?? 0) + m[0].length;
  }
  pushText(plain.slice(last));
  return out.join("");
}
