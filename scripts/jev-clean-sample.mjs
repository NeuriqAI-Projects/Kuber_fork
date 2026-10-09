/**
 * Strip the noise out of raw Firecrawl markdown before it goes to Jev.
 *
 * Measured on the 100-company sample, the stored markdown is about a quarter
 * image markup (long CDN URLs, logos, banners), a quarter link URLs and 14%
 * repeated lines, so roughly half of every page's characters carry no
 * information about what the company does.
 *
 *   node scripts/jev-clean-sample.mjs
 *
 * Reads  docs/jev-fit-test/firecrawl-raw-100.json
 * Writes docs/jev-fit-test/firecrawl-clean-100.json
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Alt text that names a logo or a decoration rather than describing content. */
const DECORATIVE_ALT = /logo|icon|image|img|banner|badge|avatar|arrow|spacer|placeholder|facebook|twitter|linkedin|instagram|youtube|whatsapp|\bflag\b/i;
/** Short boilerplate lines: consent banners, footers, share widgets. */
const BOILERPLATE = /cookie|accept all|reject all|privacy policy|terms (of use|and conditions|& conditions)|all rights reserved|©|copyright|skip to (main )?content|subscribe to|newsletter|sign up for|powered by|back to top|follow us|share (this|on)/i;

export function cleanMarkdown(md) {
  let t = md.replace(/\r/g, "");
  // Images: keep descriptive alt text, drop the markup and its URL.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
    const a = alt.replace(/\\+\s*$/gm, "").replace(/\s+/g, " ").trim();
    return a.length >= 15 && !DECORATIVE_ALT.test(a) ? a : "";
  });
  // Links: keep the visible text, drop the URL. Empty links vanish.
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare URLs and data URIs.
  t = t.replace(/https?:\/\/[^\s)\]>]+/g, "").replace(/data:[a-z]+\/[^\s)]+/g, "");
  // Firecrawl's hard line breaks and stray HTML.
  t = t.replace(/\\+[ \t]*$/gm, "").replace(/<[^>]+>/g, " ");

  const seen = new Set();
  const out = [];
  for (const line of t.split("\n")) {
    const s = line.replace(/\s+/g, " ").trim();
    if (!s || /^[-*#>\s|]+$/.test(s)) continue;               // empty bullets, rules, headings with no text
    if (s.length < 200 && BOILERPLATE.test(s)) continue;
    if (s.length >= 15) { const k = s.toLowerCase(); if (seen.has(k)) continue; seen.add(k); }
    out.push(s);
  }
  return out.join("\n");
}

if (process.argv[1].endsWith("jev-clean-sample.mjs")) {
  const src = JSON.parse(readFileSync("docs/jev-fit-test/firecrawl-raw-100.json", "utf8"));
  const orgs = src.orgs.map((o) => {
    const clean = cleanMarkdown(o.raw_markdown);
    return { ...o, raw_chars: o.markdown_chars, markdown_chars: clean.length, raw_markdown: undefined, clean_markdown: clean };
  });
  writeFileSync("docs/jev-fit-test/firecrawl-clean-100.json", JSON.stringify({ ...src, cleaned_at: new Date().toISOString(), orgs }, null, 2));
  const sum = (k) => orgs.reduce((a, o) => a + o[k], 0);
  const lens = orgs.map((o) => o.markdown_chars).sort((a, b) => a - b);
  console.log(`chars before ${sum("raw_chars").toLocaleString()} -> after ${sum("markdown_chars").toLocaleString()} (${Math.round(100 * (1 - sum("markdown_chars") / sum("raw_chars")))}% removed)`);
  console.log(`cleaned length  min ${lens[0]} · median ${lens[50]} · p90 ${lens[90]} · max ${lens.at(-1)}`);
  console.log(`pages over the 15,000-char cap: raw ${orgs.filter((o) => o.raw_chars > 15000).length} -> clean ${orgs.filter((o) => o.markdown_chars > 15000).length}`);
  console.log(`pages under 500 chars after cleaning: ${orgs.filter((o) => o.markdown_chars < 500).length}`);
}
