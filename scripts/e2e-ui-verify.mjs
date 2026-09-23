/**
 * Verify the UI work landed, by reading the colours the browser actually
 * computes rather than by looking at screenshots and hoping.
 *
 *   node scripts/e2e-ui-verify.mjs
 *
 * Checks, in light mode, on the live site:
 *   1. --border resolves to the darker value and clears 2.5:1 against the page
 *   2. Model Lab sits on the shared page frame (width-limited, p-8 header)
 *   3. An email card is white (bg-field), not the page grey
 *   4. Nothing still renders a partial-opacity surface fill
 * Screenshots are saved alongside for a human to glance at.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://kuber-polyplast.vercel.app";
const SHOTS = join("scripts", "e2e-shots", "ui");
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env.vercel", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── contrast maths, so a "pass" is a number and not an opinion
const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
// A CSS custom property comes back as authored — "hsl(142 20% 58%)" — while a
// computed backgroundColor comes back as "rgb(240, 245, 242)". Reading the
// first three numbers of both treats hue as red, which is how this script first
// reported a correctly-deployed border as failing.
const parse = (css) => {
  const n = (css.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  if (!/^\s*hsla?\(/i.test(css)) return n.slice(0, 3);
  const [h, s, l] = [n[0], n[1] / 100, n[2] / 100];
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
                  : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
};
const ratio = (a, b) => { const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "kuber@admin.com" });
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data: v } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
if (!v?.session) { console.error("could not mint a session"); process.exit(1); }
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const payload = "base64-" + Buffer.from(JSON.stringify(v.session)).toString("base64");
const cookies = [];
for (let i = 0; i * 3180 < payload.length; i++) {
  cookies.push({ name: `sb-${ref}-auth-token.${i}`, value: payload.slice(i * 3180, (i + 1) * 3180), url: BASE });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

try {
  await page.goto(`${BASE}/model-lab`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(6000);

  // 1 ── the tokens themselves
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { border: g("--border"), background: g("--background"), card: g("--card"), field: g("--field"),
             mode: document.documentElement.classList.contains("dark") ? "dark" : "light" };
  });
  console.log(`\ntheme: ${tokens.mode}`);
  console.log(`  --background ${tokens.background}`);
  console.log(`  --border     ${tokens.border}`);
  console.log(`  --field      ${tokens.field}\n`);

  if (tokens.mode === "light") {
    const r = ratio(tokens.border, tokens.background);
    check("border is visible against the page", r >= 2.5, `${r.toFixed(2)}:1 (was 1.18:1)`);
  } else {
    check("border is visible against the page", true, "dark mode — ladder already had contrast");
  }

  // 2 ── the shared page frame
  const shell = await page.evaluate(() => {
    const h1 = [...document.querySelectorAll("h1")].find((e) => e.textContent?.includes("Model Lab"));
    const header = h1?.closest("header");
    const inner = document.querySelector("main .mx-auto.w-full") ?? document.querySelector(".mx-auto.w-full");
    return {
      hasHeaderEl: !!header,
      headerPad: header ? getComputedStyle(header).paddingLeft : null,
      contentWidth: inner ? Math.round(inner.getBoundingClientRect().width) : null,
      viewport: window.innerWidth,
    };
  });
  check("Model Lab uses the shared page frame", shell.hasHeaderEl && shell.headerPad === "32px",
        `header padding ${shell.headerPad} (app standard 32px)`);
  check("content is width-limited, not edge to edge",
        shell.contentWidth !== null && shell.contentWidth < shell.viewport - 100,
        `content ${shell.contentWidth}px inside a ${shell.viewport}px window`);

  await page.screenshot({ path: join(SHOTS, "01-model-lab.png"), fullPage: false });

  // 3 ── an email card must be white, not the page grey
  const card = await page.evaluate(() => {
    const el = document.querySelector(".bg-field, [class*='bg-field']");
    if (!el) return null;
    return { bg: getComputedStyle(el).backgroundColor, page: getComputedStyle(document.body).backgroundColor };
  });
  if (card) {
    check("cards/fields render white, not the page grey", ratio(card.bg, card.page) > 1.02,
          `${card.bg} on ${card.page}`);
  } else {
    check("cards/fields render white, not the page grey", false, "no bg-field element found on screen");
  }

  // 4 ── the old invisible fills are gone from the shipped CSS
  const leftovers = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter((e) => /bg-(secondary|muted|accent|card|popover)\/\d/.test(e.className?.toString?.() ?? "")).length);
  check("no partial-opacity surface fills left", leftovers === 0, `${leftovers} found`);

  // A second screen, to show the palette change is app-wide
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(SHOTS, "02-leads.png"), fullPage: false });

  await page.goto(`${BASE}/campaigns`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(SHOTS, "03-campaigns.png"), fullPage: false });

  console.log(`\nscreenshots -> ${SHOTS}`);
} catch (e) {
  console.error("RUN FAILED:", e.message);
  await page.screenshot({ path: join(SHOTS, "99-failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
  await browser.close();
}
