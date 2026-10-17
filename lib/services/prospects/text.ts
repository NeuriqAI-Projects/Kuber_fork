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

// Cookie / consent banner lines, in the languages the client's markets use.
// A page that is only a banner then reads as "almost no text" instead of
// letting the AI guess from the company name (16 Oct 2026 test: Karina
// Plásticos, UpSolv, Kanaflex were all "good fit" from a cookie panel alone).
const COOKIE_LINE = /(cookie|consent|consentimento|consentimiento|einwilligung|gdpr|lgpd|datenschutz|privacy (settings|preferences|center|centre)|política de privacidad|política de privacidade|accept all|reject all|manage preferences|aceitar|aceptar|akzeptieren|tout accepter)/i;

/** Drop cookie and consent lines. Returns the rest, and whether any were dropped. */
export function dropCookieText(text: string): { text: string; hadCookies: boolean } {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !COOKIE_LINE.test(l));
  return { text: kept.join("\n"), hadCookies: kept.length < lines.length };
}

// Apollo sometimes stores a LinkedIn notice as the company name, e.g.
// "This page is closed. Please see Trioworld Group page" (16 Oct 2026 test).
const JUNK_NAME = /(this page is (closed|no longer)|please see .+ page|page (is )?(not available|unavailable))/i;

/** The company name to use: Apollo's, unless it is a notice — then the company
 *  it points to ("Please see X page"), else the website name, marked as such. */
export function companyName(raw: string | null | undefined, domain: string | null | undefined): string {
  const n = (raw ?? "").trim();
  if (n && !JUNK_NAME.test(n)) return n;
  const pointed = n.match(/please see (.+?) page/i)?.[1]?.trim();
  if (pointed) return pointed;
  const base = (domain ?? "").replace(/^www\./, "").split(".")[0];
  if (base) return `${base.charAt(0).toUpperCase()}${base.slice(1)} (name from website)`;
  return n || "Unknown company";
}

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
