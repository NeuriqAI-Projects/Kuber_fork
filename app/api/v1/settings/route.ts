import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, type AuthedUser } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchSettingsSchema, SETTINGS_KEYS, KNOWLEDGE_SETTINGS_KEYS } from "@/lib/validators/settings";
import { dbForUser } from "@/lib/supabase/scoped";
import { saveGroupsChecked } from "@/lib/services/prospects/keywords";

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
// prompt as the inherited fallback); only managers may change them.
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
  // context, brand logo, fallback signature. Prompt-shaped keys stay
  // manager-only — an employee editing those would rewrite every user's
  // outreach (planning.md Phase 0.5). The Knowledge Sources keys are the
  // exception: employees live in that material day to day, so they may edit it.
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

  if (caller.role !== "manager") {
    const allowed = new Set<string>(KNOWLEDGE_SETTINGS_KEYS);
    const denied = Object.keys(parsed.data).filter(
      (key) => parsed.data[key as keyof typeof parsed.data] !== undefined && !allowed.has(key),
    );
    if (denied.length > 0) {
      return fail(403, "FORBIDDEN", `Manager access required to change: ${denied.join(", ")}`);
    }
  }

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
