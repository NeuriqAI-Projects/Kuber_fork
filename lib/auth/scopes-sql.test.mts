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

// The backfill ran once (migration A). A later migration may add scopes to a template; compare
// against the template cut down to the scopes that existed in that same migration file.
const sqlFiles = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const backfillFile = sqlFiles.filter((f) => /where role = 'employee'/i.test(fs.readFileSync(path.join(DIR, f), "utf8")) &&
  /set scopes = array\[/i.test(fs.readFileSync(path.join(DIR, f), "utf8"))).pop();
const backfillSql = backfillFile ? fs.readFileSync(path.join(DIR, backfillFile), "utf8") : "";
const knownThen = names(/function public\.kuber_scopes_valid[\s\S]*?array\[([\s\S]*?)\]::text\[\]/i.exec(backfillSql)?.[1] ?? "");

for (const role of ["manager", "employee"] as const) {
  test(`backfill for role = '${role}' equals the ${role} template, same order`, () => {
    const m = new RegExp(`set scopes = array\\[([^\\]]*)\\]::text\\[\\]\\s*where role = '${role}'`, "i").exec(backfillSql);
    assert.ok(m, `no backfill "where role = '${role}'" in any migration`);
    const template = SCOPE_TEMPLATES.find((t) => t.id === role);
    assert.ok(template);
    const expected = knownThen.length ? template.scopes.filter((s) => knownThen.includes(s)) : template.scopes;
    assert.deepEqual(names(m[1]), expected);
  });
}
