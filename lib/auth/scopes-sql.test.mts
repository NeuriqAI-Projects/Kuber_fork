/**
 * npx tsx --test lib/auth/scopes-sql.test.mts
 *
 * Why this exists: the scope list lives twice, in SCOPES (lib/auth/scopes.ts) and in the DB
 * check `public.kuber_scopes_valid` (a migration the user runs by hand). If they drift, ticking
 * a new box in Settings → Team fails the DB check constraint and the save 500s — or the DB
 * accepts a scope the code has never heard of. The migration backfill must also give old
 * managers / employees exactly the Manager / Employee template, or someone silently gains or
 * loses access on deploy day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPES } from "./scopes.ts";
import { SCOPE_TEMPLATES } from "./scope-areas.ts";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");

/** Newest migration (by file name, they are date-prefixed) that (re)creates kuber_scopes_valid. */
const file = fs.readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => /create or replace function public\.kuber_scopes_valid/i.test(fs.readFileSync(path.join(DIR, f), "utf8")))
  .pop();
const sql = file ? fs.readFileSync(path.join(DIR, file), "utf8") : "";

const names = (arrayBody: string) => [...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test("a migration defines kuber_scopes_valid", () => {
  assert.ok(file, "no migration creates public.kuber_scopes_valid");
});

test("kuber_scopes_valid lists exactly SCOPES, same order", () => {
  const fn = /function public\.kuber_scopes_valid[\s\S]*?array\[([\s\S]*?)\]::text\[\]/i.exec(sql);
  assert.ok(fn, `no array[...]::text[] in kuber_scopes_valid (${file})`);
  assert.deepEqual(names(fn[1]), [...SCOPES]);
});

// The backfill ran once (migration A): one `update ... set scopes = case p.role when ... end`.
// A later migration may add scopes to a template; compare against the template cut down to the
// scopes that existed in that same migration file.
const BACKFILL = /update public\.profiles\s+\w*\s*set scopes = case\s+\w*\.?role\b([\s\S]*?)\bend\b([\s\S]*?);/i;
const backfillFile = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()
  .filter((f) => BACKFILL.test(fs.readFileSync(path.join(DIR, f), "utf8"))).pop();
const backfillSql = backfillFile ? fs.readFileSync(path.join(DIR, backfillFile), "utf8") : "";
const backfill = BACKFILL.exec(backfillSql);
const knownThen = names(/function public\.kuber_scopes_valid[\s\S]*?array\[([^\]]*)\]::text\[\]/i.exec(backfillSql)?.[1] ?? "");

test("a migration backfills scopes from the old role", () => {
  assert.ok(backfill, "no `update public.profiles ... set scopes = case ... role ... end` in any migration");
});

// The templates AS THEY WERE when migration A ran (16 Nov). Decisions 8 (17 Nov) later split
// leads:import into the four imports:* boxes, so A's manager array = today's manager template
// with those four replaced by leads:import at the same position. Employee is unchanged.
const IMPORTS = ["imports:apollo", "imports:company", "imports:excel", "imports:manual"];
function templateThen(role: "manager" | "employee"): string[] {
  const now = SCOPE_TEMPLATES.find((t) => t.id === role)!.scopes as string[];
  const out: string[] = [];
  for (const s of now) {
    if (!IMPORTS.includes(s)) out.push(s);
    else if (!out.includes("leads:import")) out.push("leads:import");
  }
  return out;
}

test("backfill file is migration A (2026_11_16_A)", () => {
  assert.match(backfillFile ?? "", /^2026_11_16_A_/);
});

for (const role of ["manager", "employee"] as const) {
  test(`backfill branch '${role}' equals the ${role} template as it was on 16 Nov, same order`, () => {
    const m = new RegExp(String.raw`when '${role}' then array\[([^\]]*)\]::text\[\]`, "i").exec(backfill?.[1] ?? "");
    assert.ok(m, `no "when '${role}' then array[...]::text[]" in the backfill (${backfillFile})`);
    const expected = templateThen(role).filter((s) => !knownThen.length || knownThen.includes(s));
    assert.deepEqual(names(m[1]), expected);
  });
}

test("the import split hard-codes the expected shapes", () => {
  assert.equal(templateThen("manager").length, 35, "manager then = 38 now - 4 imports + leads:import");
  assert.ok(templateThen("manager").includes("leads:import"));
  assert.deepEqual(templateThen("employee"), SCOPE_TEMPLATES.find((t) => t.id === "employee")!.scopes);
});

test("newest kuber_scopes_valid is the 2026_11_17 import split", () => {
  assert.match(file ?? "", /^2026_11_17_/);
});

// 2026_11_17: everyone holding leads:import gains exactly the four imports:* scopes.
test("2026_11_17 converts leads:import holders to exactly the four imports:* scopes", () => {
  const conv = /array_remove\(\s*\w+\.scopes\s*,\s*'leads:import'\s*\)\s*\|\|\s*array\[([^\]]*)\]::text\[\]/i.exec(sql);
  assert.ok(conv, `no array_remove(p.scopes, 'leads:import') || array[...] in ${file}`);
  assert.deepEqual(names(conv[1]), IMPORTS);
  assert.match(sql, /where\s+'leads:import'\s*=\s*any\(\s*\w+\.scopes\s*\)/i, "conversion must only touch leads:import holders");
});

// One-time on purpose: re-running the file must never give template boxes back to someone the
// owner deliberately emptied, so it only runs in a company where nobody has scopes yet.
test("backfill only runs in a company where nobody has scopes yet", () => {
  const where = backfill?.[2] ?? "";
  assert.match(where, /not exists\s*\([\s\S]*scopes\s*<>\s*'\{\}'[\s\S]*\)/i, "backfill lacks the one-time `not exists (... scopes <> '{}')` guard");
  assert.match(where, /\bscopes\s*=\s*'\{\}'/i, "backfill must only fill members with no scopes");
  assert.match(where, /not\s+\w*\.?is_owner/i, "backfill must skip the owner");
});
