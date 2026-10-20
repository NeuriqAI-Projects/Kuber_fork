// Small helpers every assistant tool shares: name → id resolution, safe text
// search, and paged column reads for breakdowns.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessibleCampaignIds } from "@/lib/auth/scope";
import type { AssistantCaller } from "@/lib/services/assistant/context";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): boolean => !!v && UUID_RE.test(v.trim());

/** Strip characters that would break out of a PostgREST `.or(...)`/ilike filter. */
export function cleanSearch(raw: string): string {
  return raw.replace(/[,()"\\%*:]/g, " ").replace(/\s+/g, " ").trim();
}

export function personName(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last].filter(Boolean).join(" ").trim() || "(no name)";
}

export function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export type TeamMember = { id: string; name: string; email: string | null; role: string | null; is_active: boolean | null };

/** One read per request: several tools in the same answer all need the team. */
const teamMemo = new WeakMap<SupabaseClient, Promise<TeamMember[]>>();

/** Everyone in the company (profiles is company-scoped through the scoped client). */
export function loadTeam(db: SupabaseClient): Promise<TeamMember[]> {
  const hit = teamMemo.get(db);
  if (hit) return hit;
  const p = readTeam(db);
  teamMemo.set(db, p);
  return p;
}

async function readTeam(db: SupabaseClient): Promise<TeamMember[]> {
  const { data } = await db.from("profiles").select("id, full_name, email, role, is_active");
  return (data ?? []).map((p) => ({
    id: p.id as string,
    name: (p.full_name as string | null) || (p.email as string | null) || "Unknown",
    email: (p.email as string | null) ?? null,
    role: (p.role as string | null) ?? null,
    is_active: (p.is_active as boolean | null) ?? null,
  }));
}

export function teamNameMap(team: TeamMember[]): Map<string, string> {
  return new Map(team.map((m) => [m.id, m.name]));
}

/**
 * "me", "unassigned", a name, an email or an id → a user id (or "unassigned").
 * Returns an error string when the name matches nobody or several people, so
 * the model can ask instead of guessing.
 */
export async function resolveAssignee(
  caller: AssistantCaller,
  raw: string,
): Promise<{ id: string | "unassigned"; name: string } | { error: string }> {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (["me", "myself", "mine", "i"].includes(lower)) return { id: caller.userId, name: "you" };
  if (["unassigned", "nobody", "none", "no one"].includes(lower)) return { id: "unassigned", name: "unassigned" };
  const team = await loadTeam(caller.db);
  if (isUuid(v)) {
    const m = team.find((t) => t.id === v);
    return m ? { id: m.id, name: m.name } : { error: `No teammate with id ${v}.` };
  }
  const matches = team.filter((t) =>
    t.name.toLowerCase().includes(lower) || (t.email ?? "").toLowerCase().includes(lower),
  );
  const exact = matches.filter((t) => t.name.toLowerCase() === lower || (t.email ?? "").toLowerCase() === lower);
  const pick = exact.length === 1 ? exact : matches;
  if (pick.length === 1) return { id: pick[0].id, name: pick[0].name };
  if (pick.length === 0) return { error: `No teammate matches "${v}". Team: ${team.map((t) => t.name).join(", ")}.` };
  return { error: `"${v}" matches several people: ${pick.map((t) => t.name).join(", ")}. Ask which one.` };
}

export type CampaignRef = { id: string; name: string; status: string };

/** Campaign ids this caller may see — null means "all" (managers). */
export async function accessibleCampaignIds(caller: AssistantCaller): Promise<string[] | null> {
  if (caller.role !== "employee") return null;
  return getAccessibleCampaignIds(caller.db, {
    id: caller.userId, role: caller.role, isSuperAdmin: false, companyId: caller.companyId,
  });
}

/** Lowercase, punctuation-free form used to compare names a user typed with stored ones. */
export function normalizeName(v: string): string {
  return v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Campaign by id or name. Names are matched in code rather than with ilike:
 * real campaign names contain ":", "(", "—" and other characters that filter
 * syntax mangles (a name like "Launch 09-10 17:23 IST" was not found that way). Order:
 * exact → normalized exact → contains → every word present. Campaign lists are
 * small (hundreds), so reading id+name for all of them is one cheap query.
 */
export async function resolveCampaign(
  caller: AssistantCaller,
  raw: string,
): Promise<CampaignRef | { error: string }> {
  const v = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  const allowed = await accessibleCampaignIds(caller);
  let q = caller.db.from("campaigns").select("id, name, status").eq("is_deleted", false);
  if (isUuid(v)) q = q.eq("id", v);
  const { data } = await q.order("created_at", { ascending: false }).limit(1000);
  let rows = (data ?? []) as CampaignRef[];
  if (allowed) rows = rows.filter((r) => allowed.includes(r.id));
  if (isUuid(v)) return rows[0] ?? { error: `No campaign with id ${v}.` };

  const target = normalizeName(v);
  const words = target.split(" ").filter(Boolean);
  const tiers = [
    rows.filter((r) => r.name.toLowerCase() === v.toLowerCase()),
    rows.filter((r) => normalizeName(r.name) === target),
    rows.filter((r) => normalizeName(r.name).includes(target)),
    rows.filter((r) => words.length > 0 && words.every((w) => normalizeName(r.name).split(" ").includes(w))),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) {
      return { error: `"${v}" matches ${tier.length} campaigns: ${tier.slice(0, 8).map((r) => `"${r.name}" (${r.status})`).join(", ")}. Ask which one.` };
    }
  }
  return { error: `No campaign matches "${v}".` };
}

/** A value for `.ilike()`: keeps punctuation (it is a plain query value), drops only wildcards. */
export function ilikeValue(raw: string): string {
  return raw.replace(/[%*\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Read one or more columns for every row a query matches, a page at a time.
 * Used by breakdowns ("leads by country") where PostgREST has no GROUP BY.
 * Capped so a runaway question cannot pull the whole table.
 */
export async function readAllPages<T>(
  // Loosely typed: callers build select strings at runtime, which supabase-js cannot infer.
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  cap = 20_000,
  pageSize = 1000,
): Promise<{ rows: T[]; truncated: boolean }> {
  // First page alone: most questions fit in it, and its size tells us whether
  // to fetch more. The rest are fetched a few at a time in parallel — a 5,000
  // row breakdown is one round-trip of latency, not five.
  const first = await build(0, Math.min(pageSize, cap) - 1);
  if (first.error) throw new Error(first.error.message);
  const rows = [...((first.data ?? []) as T[])];
  if (rows.length < pageSize) return { rows, truncated: false };
  const PARALLEL = 4;
  for (let start = pageSize; start < cap; start += pageSize * PARALLEL) {
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < PARALLEL; i++) {
      const from = start + i * pageSize;
      if (from >= cap) break;
      ranges.push([from, Math.min(from + pageSize, cap) - 1]);
    }
    const pages = await Promise.all(ranges.map(([from, to]) => build(from, to)));
    for (const p of pages) {
      if (p.error) throw new Error(p.error.message);
      const page = (p.data ?? []) as T[];
      rows.push(...page);
      if (page.length < pageSize) return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}

export function countBy<T>(rows: T[], key: (r: T) => string | null | undefined): Array<{ value: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "(none)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

export const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Trim long text for the model: enough to understand, not enough to blow the context. */
export function clip(text: string | null | undefined, max = 600): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
