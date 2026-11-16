const APP_SUBDOMAINS = /^(app|dashboard|portal|login|my|account|admin|web|mail|crm|api|secure)\./i;

export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim();
  // A domain never contains "@" — this almost always means a spreadsheet/form
  // column got misaligned and an email address landed in a domain field
  // (e.g. "jmbpmurphy@o2.ie" typed into "Company Domain"). Stripping down to
  // the part after "@" would still be wrong — that's the person's own email
  // host, not necessarily the company's — and accepting it is exactly how a
  // scrape ends up reading a site unrelated to the org. Fail closed instead.
  if (trimmed.includes("@")) return "";
  const domain = trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")           // strip path
    .toLowerCase()
    .replace(APP_SUBDOMAINS, "");   // strip non-marketing subdomains
  // A real website always has a dot. Stripping "mail." from "mail.com" used to
  // leave just "com", and orgs saved with domain "com" or "ru" then matched
  // unrelated leads as "the same company" (16 Nov 2026). Fail closed.
  return domain.includes(".") ? domain : "";
}

// Free/webmail providers — never inferred as a company's own domain.
export const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "icloud.com",
  "protonmail.com", "proton.me", "aol.com", "gmx.com", "gmx.net", "gmx.de", "yandex.com", "yandex.ru",
  "zoho.com", "zohomail.com", "mail.com", "rediffmail.com", "rediff.com", "live.com", "msn.com", "me.com",
  "mac.com", "hanmail.net", "daum.net", "naver.com", "qq.com", "163.com", "126.com", "sina.com",
  "mail.ru", "inbox.ru", "list.ru", "bk.ru", "web.de", "t-online.de", "libero.it", "orange.fr",
  "free.fr", "laposte.net", "wanadoo.fr", "comcast.net", "sbcglobal.net", "att.net", "verizon.net",
  "btinternet.com", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "tutanota.com", "fastmail.com",
]);
// Country editions of the big webmail brands (yahoo.co.in, hotmail.co.uk, outlook.in, live.fr…).
const FREE_EMAIL_BRANDS = /^(yahoo|ymail|hotmail|outlook|live|msn|gmail|aol|gmx|yandex|rediffmail)\.[a-z.]+$/;

function isFreeEmailHost(host: string): boolean {
  return FREE_EMAIL_PROVIDERS.has(host) || FREE_EMAIL_BRANDS.test(host);
}

const EMAIL_REGEX = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

/**
 * Derives a normalized company domain from a lead's email address.
 * Returns null for malformed addresses or free/webmail providers.
 */
export function deriveDomainFromEmail(email: string): string | null {
  const match = EMAIL_REGEX.exec(email.trim().toLowerCase());
  if (!match) return null;
  // Check the email's own host BEFORE normalizing: normalizeDomain strips
  // "mail." as an app subdomain, which turned "x@mail.com" into "com".
  if (isFreeEmailHost(match[1])) return null;
  const domain = normalizeDomain(match[1]);
  if (!domain || isFreeEmailHost(domain)) return null;
  return domain;
}
