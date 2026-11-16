/**
 * npx tsx --test lib/auth/access-wiring.test.mts
 *
 * Why this exists: permissions are per-member scopes (docs/notes/scopes-plan.md). A route,
 * page, nav item or Kuber AI tool that FORGETS its scope still works for the owner (who holds
 * everything), so nobody notices in testing, and it leaks to every other member. This is a
 * static scan of the source, so it catches that the moment the code is written:
 *  - every API handler calls requireScope (or requireAuth + assertScope), except a short,
 *    commented allow-list of public / secret-only / open-to-every-member routes;
 *  - a write handler is never guarded by a `:read` scope (unless marked as a UI-state POST);
 *  - every scope string in the code exists in SCOPES (a typo would 403 everyone, or a scope
 *    missing from SCOPES could never be ticked);
 *  - the owner-only list stays pinned (empty today);
 *  - nav items and pages are gated, old role checks are gone, every AI tool declares scopes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPES } from "./scopes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = path.join(ROOT, "app", "api");

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}
const rel = (p: string, from = ROOT) => path.relative(from, p).split(path.sep).join("/");
const read = (p: string) => fs.readFileSync(p, "utf8");

// ── Route handlers ──────────────────────────────────────────────────────────
type Handler = { route: string; method: string; body: string };
const METHOD_RE = /export (?:async function|const) (GET|POST|PATCH|PUT|DELETE)\b/g;

const routeFiles = walk(API, (p) => p.endsWith(`${path.sep}route.ts`));
const handlers: Handler[] = routeFiles.flatMap((file) => {
  const src = read(file);
  const route = rel(path.dirname(file), API); // e.g. "v1/leads/[id]"
  const hits = [...src.matchAll(METHOD_RE)];
  return hits.map((m, i) => ({
    route,
    method: m[1],
    body: src.slice(m.index!, i + 1 < hits.length ? hits[i + 1].index : src.length),
  }));
});
const key = (h: Handler) => `${h.method} ${h.route}`;

/** "*" = every handler in the file. */
type AllowList = Record<string, "*" | string[]>;

// PUBLIC: no auth at all, by design (plan §2 "Public").
const PUBLIC: AllowList = {
  "v1/health": ["GET"], // liveness ping
  "v1/meta/locations": ["GET"], // static country list
  "v1/campaigns/generate-emails": ["POST"], // dead 410 stub
  "v1/drafts": ["POST"], // dead 410 stub (GET /drafts is scoped)
};

// SECRET: machine-to-machine, outside the member scope model (plan §2 "Secret-only").
// These must check a shared secret instead.
const SECRET: AllowList = {
  "internal/*": "*", // every app/api/internal/* route (cron + self-chains)
  "enrich/scrape-orgs": "*",
  "enrich/generate-drafts": "*",
  "enrich/regenerate-drafts": "*",
  "v1/webhooks/instantly": "*", // INSTANTLY_WEBHOOK_SECRET
  "v1/unibox/sync": ["GET"], // Vercel cron
};

// OPEN: every active member via requireAuth, no scope (plan §2 "Open to every active member").
const OPEN: AllowList = {
  "v1/me/availability": "*", // own online/offline
  "v1/me/settings": "*", // own writing prompt, signature, theme
  "v1/settings/signature": "*", // own signature
  "v1/user-signature": "*", // own signature (old route, kept: plan §7 E)
  "v1/settings": ["GET"], // company prompt is the fallback for everyone's own prompt
  "v1/settings/logo": ["GET"], // logo shows in everyone's sidebar
  "v1/settings/prompt-meta": "*", // system prompt updated_at
  "v1/apollo-credits": "*", // sidebar pill, shown to all today
  "v1/service-health": "*", // outage banner
  "v1/assistant/threads": "*", // own Kuber AI chats
  "v1/assistant/threads/[id]": "*", // own Kuber AI chat
  // (reply-mailing-list is NOT open: it feeds the reply box only → unibox:reply)
};

function listed(list: AllowList, h: Handler): boolean {
  for (const [route, methods] of Object.entries(list)) {
    const hit = route.endsWith("/*") ? h.route.startsWith(route.slice(0, -1)) : h.route === route;
    if (hit && (methods === "*" || methods.includes(h.method))) return true;
  }
  return false;
}

const hasScopeGuard = (body: string) =>
  /\brequireScope\(/.test(body) || (/\brequireAuth\(/.test(body) && /\bassertScope\(/.test(body));
const hasSecretCheck = (body: string) => /\bsafeSecretEqual\(|INTERNAL_SECRET|CRON_SECRET/.test(body);

test("found the route handlers", () => {
  assert.ok(routeFiles.length >= 130, `only ${routeFiles.length} route files found`);
  assert.ok(handlers.length >= 180, `only ${handlers.length} handlers found`);
});

test("every user-facing handler calls requireScope (or requireAuth + assertScope)", () => {
  const bad: string[] = [];
  for (const h of handlers) {
    if (listed(PUBLIC, h)) continue;
    if (listed(SECRET, h)) {
      if (!hasSecretCheck(h.body)) bad.push(`${key(h)}  (secret route without safeSecretEqual / INTERNAL_SECRET / CRON_SECRET)`);
      continue;
    }
    if (listed(OPEN, h)) {
      if (!/\brequire(Auth|Scope)\(/.test(h.body)) bad.push(`${key(h)}  (open route without requireAuth)`);
      continue;
    }
    // POST unibox/sync: plan §7 B. The INTERNAL_SECRET branch stays; the user branch needs unibox:all.
    if (h.route === "v1/unibox/sync" && h.method === "POST") {
      if (!/\brequireScope\(\s*\w+\s*,\s*["']unibox:all["']/.test(h.body)) bad.push(`${key(h)}  (user branch must use requireScope(…, "unibox:all"))`);
      continue;
    }
    if (!hasScopeGuard(h.body)) bad.push(key(h));
  }
  assert.deepEqual(bad, [], `${bad.length} handler(s) without a scope guard:\n  ${bad.join("\n  ")}`);
});

const READ_MARKER = "// scopes: read-only POST (UI state)";
test("no write handler is guarded by a :read scope (unless marked as a UI-state POST)", () => {
  const bad: string[] = [];
  for (const h of handlers) {
    if (h.method === "GET") continue;
    const lines = h.body.split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /\brequireScope\(\s*\w+\s*,\s*["']([a-z_]+:read)["']/.exec(line);
      if (m && !(lines[i - 1] ?? "").includes(READ_MARKER)) bad.push(`${key(h)} → ${m[1]}`);
    });
  }
  assert.deepEqual(bad, [], `write handlers guarded by a read scope:\n  ${bad.join("\n  ")}`);
});

// Owner-only handlers. Adding one is a PRODUCT DECISION: ask the user first and write the
// reason next to the entry (plan Decisions 5 / §3: the list stays empty).
const OWNER_ONLY: string[] = [];
test("owner-only handlers match the pinned list", () => {
  const found = handlers.filter((h) => /\brequireScope\(\s*\w+\s*,\s*["']owner["']/.test(h.body)).map(key).sort();
  assert.deepEqual(found, OWNER_ONLY);
});

// ── Source-wide scans ───────────────────────────────────────────────────────
const sourceFiles = ["app", "lib", "components"].flatMap((d) =>
  walk(path.join(ROOT, d), (p) => /\.(ts|tsx|mts)$/.test(p) && !/\.test\./.test(p)),
);

test("every scope string used in code is in SCOPES", () => {
  const known = new Set<string>(SCOPES);
  const used = new Map<string, string>();
  const CALL = /\b(?:requireScope|assertScope|requirePageScope|can|hasScope)\(([^()]*)\)/g;
  const FIELD = /\bscope:\s*(["'][a-z_]+:[a-z_]+["'])/g;
  for (const file of sourceFiles) {
    const src = read(file);
    for (const m of [...src.matchAll(CALL), ...src.matchAll(FIELD)]) {
      for (const lit of m[1].matchAll(/["']([a-z_]+:[a-z_]+)["']/g)) used.set(lit[1], rel(file));
    }
  }
  assert.ok(used.size > 0, "no scope literals found at all");
  const unknown = [...used].filter(([s]) => !known.has(s)).map(([s, f]) => `${s} (${f})`);
  assert.deepEqual(unknown, [], `unknown scopes:\n  ${unknown.join("\n  ")}`);
});

/** Drop comments so prose about the old model ("was isSuperAdmin") is allowed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("old role / super-admin checks are gone", () => {
  const BANNED: RegExp[] = [
    /\brole\s*[!=]==\s*["'](manager|employee)["']/,
    /["'](manager|employee)["']\s*[!=]==\s*\w*\.?role\b/,
    // `.role` on a person. Chat messages use `role: "user"` / `m.role`, so only these names.
    /\b(user|caller|profile|p|u|me|existing|target)\.role\b/,
    /\.eq\(\s*["']role["']\s*,\s*["'](manager|employee)["']/,
    /\bisSuperAdmin\b/, /\bis_super_admin\b/,
    /\brequireManager\b/, /\brequireSuperAdmin\b/, /\brequireManagerSession\b/,
    /\bmanagerOnly\b/, /\bgetUserRole\b/, /\bisAppUser\b/,
    /app_metadata\??\.role\b/,
  ];
  const bad: string[] = [];
  for (const file of sourceFiles) {
    const lines = stripComments(read(file)).split(/\r?\n/);
    lines.forEach((line, i) => {
      const re = BANNED.find((b) => b.test(line));
      if (re) bad.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], `${bad.length} old role check(s):\n  ${bad.join("\n  ")}`);
});

// ── Nav + pages ─────────────────────────────────────────────────────────────
const shell = read(path.join(ROOT, "app", "(app)", "app-shell.tsx"));
const navBlock = /const NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(shell)?.[1] ?? "";
const navItems = [...navBlock.matchAll(/\{[^{}]*href:\s*["']([^"']+)["'][^{}]*\}/g)].map((m) => ({ href: m[1], text: m[0] }));

test("every NAV_ITEMS entry has a scope, except Settings", () => {
  assert.ok(navItems.length >= 6, "NAV_ITEMS not found in app/(app)/app-shell.tsx");
  for (const item of navItems) {
    if (item.href === "/settings") continue;
    assert.match(item.text, /\bscope:\s*["'][a-z_]+:[a-z_]+["']/, `nav item ${item.href} has no scope`);
  }
});

test("every page under app/(app)/ sits under a nav item (so the page gate covers it)", () => {
  const pages = walk(path.join(ROOT, "app", "(app)"), (p) => p.endsWith(`${path.sep}page.tsx`));
  assert.ok(pages.length > 0);
  const hrefs = navItems.map((n) => n.href);
  const orphans = pages
    .map((p) => "/" + rel(path.dirname(p), path.join(ROOT, "app", "(app)")).split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/"))
    .filter((route) => !hrefs.some((h) => route === h || route.startsWith(`${h}/`)));
  assert.deepEqual(orphans, [], `pages outside every nav item: ${orphans.join(", ")}`);
});

// ── Kuber AI tools ──────────────────────────────────────────────────────────
// Shape not settled yet when this was written: accept either `scopes:` inside the tool's own
// block, or a map entry `<tool_name>: ["x:y", ...]` (or `: "x:y"`) anywhere in tools/.
test("every Kuber AI tool declares its scopes", () => {
  const dir = path.join(ROOT, "lib", "services", "assistant", "tools");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => read(path.join(dir, f)));
  const all = files.join("\n");
  const tools: { name: string; block: string }[] = [];
  for (const src of files) {
    const hits = [...src.matchAll(/\b(\w+):\s*tool\(\s*\{/g)];
    hits.forEach((m, i) => tools.push({ name: m[1], block: src.slice(m.index!, hits[i + 1]?.index ?? src.length) }));
  }
  assert.ok(tools.length >= 21, `only ${tools.length} tools found`);
  const missing = tools
    .filter(({ name, block }) =>
      !/\bscopes\s*:/.test(block) &&
      !new RegExp(`\\b${name}["']?\\s*:\\s*\\[?\\s*["'][a-z_]+:[a-z_]+["']`).test(all))
    .map((t) => t.name);
  assert.deepEqual(missing, [], `tools without scopes: ${missing.join(", ")}`);
});
