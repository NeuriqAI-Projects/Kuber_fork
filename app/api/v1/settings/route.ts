import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, assertScope, type AuthedUser } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchSettingsSchema, SETTINGS_KEYS, KNOWLEDGE_SETTINGS_KEYS } from "@/lib/validators/settings";
import { dbForUser } from "@/lib/supabase/scoped";
import { saveGroupsChecked } from "@/lib/services/prospects/keywords";

export const maxDuration = 60;

async function readSettings(db: SupabaseClient) {
  const { data, error } = await db.from("settings").select("key, value").in("key", [...SETTINGS_KEYS]);
  if (error) throw fail(500, "INTERNAL", error.message);

  const result: Record<string, string> = {};
  for (const key of SETTINGS_KEYS) result[key] = "";
  for (const row of data ?? []) {
    if (row.key && row.value != null) result[row.key] = row.value;
  }
  return result;
}

// Everyone may READ company settings (the UI shows e.g. the company-default
// prompt as the inherited fallback); changing them needs settings:write.
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  try {
    return ok(await readSettings(db));
  } catch (r) {
    return r as Response;
  }
}

export async function PATCH(req: NextRequest) {
  // Company-wide configuration: prompts/templates, product library, company
  // context, brand logo, fallback signature. Prompt-shaped keys need
  // settings:write — a member editing those would rewrite every user's
  // outreach (planning.md Phase 0.5). The Knowledge Sources keys have their own
  // scope, knowledge:write: lead owners live in that material day to day, so the
  // Employee template holds it. A body touching both kinds needs both scopes.
  // Personal preferences live at /api/v1/me/settings instead.
  let caller: AuthedUser;
  try { caller = await requireAuth(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  // The Industry Segments list as the client last loaded it: when sent, the list is saved only if
  // nobody changed it since (never silently over a teammate's change). Not a setting itself.
  const base = typeof body?.industry_keyword_groups_base === "string" ? body.industry_keyword_groups_base as string : null;
  if (body && typeof body === "object") delete body.industry_keyword_groups_base;
  const parsed = PatchSettingsSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const knowledge = new Set<string>(KNOWLEDGE_SETTINGS_KEYS);
  const touched = Object.keys(parsed.data).filter((key) => parsed.data[key as keyof typeof parsed.data] !== undefined);
  try {
    if (touched.some((key) => knowledge.has(key))) assertScope(caller, "knowledge:write");
    if (touched.some((key) => !knowledge.has(key))) assertScope(caller, "settings:write");
  } catch (r) { return r as Response; }

  const db = dbForUser(caller);

  if (base !== null && parsed.data.industry_keyword_groups !== undefined) {
    try {
      const r = await saveGroupsChecked(db, parsed.data.industry_keyword_groups, base);
      if (!r.ok) return fail(409, "CONFLICT", r.message);
    } catch (e) { return fail(500, "INTERNAL", (e as Error).message); }
  }

  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined || (key === "industry_keyword_groups" && base !== null)) continue;
    const { error } = await db.from("settings").upsert(
      { key, value },
      { onConflict: "key" },
    );
    if (error) return fail(500, "INTERNAL", error.message);
  }

  try {
    return ok(await readSettings(db));
  } catch (r) {
    return r as Response;
  }
}
