// Turning web pages into text the scorer can read, and finding a company's
// second page for free. Measured on 1 Oct 2026 (Firecrawl-Test/): cleaning
// cuts the median page from 7,863 to 3,068 chars with no facts lost, and our
// own GET read the About page on 5 of 5 sites, so the second page costs nothing.

/** Drop images, keep link text, drop bare URLs and repeated lines. */
export function cleanText(md: string): string {
  const seen = new Set<string>();
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s#>*\-|]+/, "").replace(/[*_`|]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => {
      const k = l.toLowerCase();
      if (!l || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join("\n");
}

export const wordCount = (t: string): number => (t.match(/\p{L}{2,}/gu) ?? []).length;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Every link URL in a markdown page, made absolute against `base`. */
export function linksFromMarkdown(md: string, base: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)/g)) {
    try { out.push(new URL(m[1], base).toString()); } catch { /* not a URL */ }
  }
  return out;
}

const ABOUT = /about|company|who-?we-?are|quienes|nosotros|empresa|sobre|chi-siamo|azienda|uber-uns|unternehmen|qui-sommes|societe|entreprise|hakkimizda|profile/i;
const PRODUCTS = /product|produc|produt|prodott|produit|urun|solution|process|servic|capabilit/i;

/** Best second page on the same site: About-type first, then Products, shortest wins. */
export function pickSecondPage(homeUrl: string, urls: string[]): string | null {
  let host: string;
  try { host = new URL(homeUrl).host.replace(/^www\./, ""); } catch { return null; }
  const rank = (u: string): number => {
    let p: URL;
    try { p = new URL(u); } catch { return 0; }
    if (p.host.replace(/^www\./, "") !== host) return 0;
    if (/\.(pdf|pptx?|jpe?g|png|zip|xml)$/i.test(p.pathname) || p.pathname.length < 2) return 0;
    return ABOUT.test(p.pathname) ? 3 : PRODUCTS.test(p.pathname) ? 2 : 0;
  };
  return urls
    .map((u) => [rank(u), u] as const)
    .filter(([r]) => r > 0)
    .sort((a, b) => b[0] - a[0] || a[1].length - b[1].length)[0]?.[1] ?? null;
}

/** Page URLs listed in a sitemap XML (one level of sitemap index followed by the caller). */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}
