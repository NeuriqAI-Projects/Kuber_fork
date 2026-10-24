// Industry keyword groups (settings.industry_keyword_groups) changed without losing a
// teammate's change. Every write is a compare-and-swap on the row's updated_at (a trigger
// sets it on each update): "update … where updated_at = what I read". 0 rows changed =
// someone else saved in between.
//   addKeyword       one keyword into one group: re-reads and retries on a clash
//   saveGroupsChecked the whole list (Settings): refuses when the list changed since `base`
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseIndustryKeywordGroups, type IndustryKeywordGroup } from "@/lib/constants";

const KEY = "industry_keyword_groups";
export const KEYWORDS_CHANGED = "Someone else changed these keywords just now — reload the page and try again.";

type Row = { value: string | null; updated_at: string } | null;
type Write = { ok: true } | { ok: false; error?: string };

async function readRow(db: SupabaseClient): Promise<Row> {
  const { data, error } = await db.from("settings").select("value, updated_at").eq("key", KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Row;
}

/** Write `value` only if the row is still the one read (`row`); no row yet = insert (a clash = the unique key). */
async function swap(db: SupabaseClient, row: Row, value: string): Promise<Write> {
  if (!row) {
    const { error } = await db.from("settings").insert({ key: KEY, value });
    if (!error) return { ok: true };
    return (error as { code?: string }).code === "23505" || /duplicate/i.test(error.message) ? { ok: false } : { ok: false, error: error.message };
  }
  const { data, error } = await db.from("settings").update({ value }).eq("key", KEY).eq("updated_at", row.updated_at).select("key");
  if (error) return { ok: false, error: error.message };
  return (data ?? []).length ? { ok: true } : { ok: false };
}

export type AddResult =
  | { ok: true; groups: IndustryKeywordGroup[] }
  | { ok: false; code: "NO_GROUP" | "DUPLICATE" | "BUSY"; message: string; groups?: IndustryKeywordGroup[] };

/** Adds one keyword to one group, atomically. A duplicate (any group, any case) is refused with that group's name. */
export async function addKeyword(db: SupabaseClient, k: { groupId: string; label: string; query: string; id?: string }, tries = 5): Promise<AddResult> {
  const label = k.label.trim(), query = k.query.trim() || label;
  const id = k.id ?? crypto.randomUUID();
  for (let i = 0; i < tries; i++) {
    const row = await readRow(db);
    const groups = parseIndustryKeywordGroups(row?.value);
    const target = groups.find((g) => g.id === k.groupId);
    if (!target) return { ok: false, code: "NO_GROUP", message: "That group was removed in Settings. Pick another group.", groups };
    const same = (x: { label: string }) => x.label.trim().toLowerCase() === label.toLowerCase();
    const owner = groups.find((g) => g.keywords.some(same));
    if (owner) {
      return { ok: false, code: "DUPLICATE", groups, message: owner.id === target.id
        ? `"${label}" is already in ${owner.label}.`
        : `"${label}" is already in ${owner.label}. Pick it there, or rename or move it in Settings > Industry segments.` };
    }
    const next = groups.map((g) => (g.id === target.id ? { ...g, keywords: [...g.keywords, { id, label, query }] } : g));
    const w = await swap(db, row, JSON.stringify(next));
    if (w.ok) return { ok: true, groups: next };
    if (w.error) throw new Error(w.error);
  }
  return { ok: false, code: "BUSY", message: "Too many keyword changes at once. Try again in a moment." };
}

/** Saves the whole list only if nobody changed it since the client loaded `base` (the list as it last saw it). */
export async function saveGroupsChecked(db: SupabaseClient, next: string, base: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const row = await readRow(db);
  // Compared as parsed lists: the raw text may be "" (built-in defaults) or carry rows the parser drops.
  const norm = (raw: string | null | undefined) => JSON.stringify(parseIndustryKeywordGroups(raw));
  if (norm(row?.value) !== norm(base)) return { ok: false, message: KEYWORDS_CHANGED };
  const w = await swap(db, row, next);
  if (w.ok) return { ok: true };
  if (w.error) throw new Error(w.error);
  return { ok: false, message: KEYWORDS_CHANGED };
}
