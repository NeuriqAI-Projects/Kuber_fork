import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertLeadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

type EventMeta = {
  assignee_id?: string;
  to?: string;
  from?: string;
  campaign_id?: string;
} | null;

// Clean, human-readable per-lead activity timeline for the drawer (Problem 8).
// Distinct from /api/enrich/status, which is the raw org-scrape debug trail.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  // Employees may only see their own assigned leads' activity.
  try { await assertLeadAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: events, error } = await db
    .from("lead_events")
    .select("event, detail, actor_id, metadata, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return fail(500, "INTERNAL", error.message);

  // Assignment events were logged with a generic detail string ("Assigned to
  // an employee") because the assignee's name isn't known at write time in
  // every call site (auto-assignment, bulk campaign-assign, etc.) — every one
  // of them does store the raw assignee id(s) in metadata, though. Resolving
  // the name here at read time, instead of writing it once at insert time,
  // means this also fixes every already-logged historical event for free —
  // no backfill migration needed.
  const ASSIGNMENT_EVENTS = new Set(["assigned", "reassigned", "unassigned"]);
  const nameNeededIds = new Set<string>();
  for (const e of events ?? []) {
    if (e.actor_id) nameNeededIds.add(e.actor_id as string);
    if (ASSIGNMENT_EVENTS.has(e.event as string)) {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      // "assigned" events store the target as assignee_id at most call sites,
      // but as `to` at the campaign-assign route — check both.
      for (const key of ["assignee_id", "to", "from"]) {
        const v = meta[key];
        if (typeof v === "string") nameNeededIds.add(v);
      }
    }
  }

  const names = new Map<string, string>();
  if (nameNeededIds.size > 0) {
    const { data: profiles } = await db.from("profiles").select("id, full_name, email").in("id", [...nameNeededIds]);
    for (const p of profiles ?? []) names.set(p.id as string, (p.full_name || p.email) as string);
  }

  // Resolve campaign names so the drawer can render them as links.
  const campaignIds = [...new Set(
    (events ?? []).map((e) => (e.metadata as EventMeta)?.campaign_id).filter(Boolean) as string[],
  )];
  const campaignNames = new Map<string, string>();
  if (campaignIds.length > 0) {
    const { data: campaigns } = await db.from("campaigns").select("id, name").in("id", campaignIds);
    for (const c of campaigns ?? []) campaignNames.set(c.id as string, c.name as string);
  }

  function resolvedDetail(event: string, storedDetail: string | null, metadata: unknown): string {
    if (!ASSIGNMENT_EVENTS.has(event)) return storedDetail ?? event;
    const meta = (metadata ?? {}) as Record<string, unknown>;
    const toId = (meta.assignee_id ?? meta.to) as string | undefined;
    const fromId = meta.from as string | undefined;
    const toName = toId ? names.get(toId) : undefined;
    const fromName = fromId ? names.get(fromId) : undefined;

    if (event === "assigned") return toName ? `Assigned to ${toName}` : (storedDetail ?? event);
    if (event === "reassigned") {
      if (toName && fromName) return `Reassigned from ${fromName} to ${toName}`;
      if (toName) return `Reassigned to ${toName}`;
      return storedDetail ?? event;
    }
    // unassigned
    return fromName ? `Returned to the pool (was assigned to ${fromName})` : (storedDetail ?? event);
  }

  return ok({
    events: (events ?? []).map((e) => {
      const campaignId = (e.metadata as EventMeta)?.campaign_id ?? null;
      return {
        event: e.event,
        detail: resolvedDetail(e.event as string, e.detail, e.metadata),
        actor_name: e.actor_id ? (names.get(e.actor_id as string) ?? null) : null,
        campaign_id: campaignId,
        campaign_name: campaignId ? (campaignNames.get(campaignId) ?? null) : null,
        created_at: e.created_at,
      };
    }),
  });
}
