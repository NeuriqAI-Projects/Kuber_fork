/**
 * Per-member permissions ("scopes"). Pure: no DB, no network.
 *
 * A member holds exactly the scopes ticked for them in Settings → Team
 * (`profiles.scopes`). The company owner (`profiles.is_owner`) holds every scope.
 * A deactivated member holds none. The code never asks "is this a manager?" —
 * it asks "does this person hold `leads:assign`?". See docs/scopes.md.
 *
 * Adding a scope: add it here, in SCOPE_AREAS (lib/auth/scope-areas.ts), and in a
 * migration that re-creates public.kuber_scopes_valid (same order). The drift test
 * (scopes-sql.test.mts) fails until all three agree.
 */

export const SCOPES = [
  "dashboard:read", "dashboard:all",
  "leads:read", "leads:all", "leads:write", "leads:assign", "leads:delete", "leads:import",
  "organizations:read", "organizations:write",
  "prospects:read", "prospects:run",
  "campaigns:read", "campaigns:all", "campaigns:write", "campaigns:generate", "campaigns:assign", "campaigns:send", "campaigns:delete",
  "unibox:read", "unibox:all", "unibox:reply", "unibox:write",
  "model_lab:read", "model_lab:write",
  "credits:read",
  "assistant:use", "assistant:actions", "assistant:admin",
  "settings:write",
  "knowledge:write",
  "keys:read", "keys:write", "sending_accounts:write",
  "team:read", "team:write",
] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);
export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/** Check a list from a form or request: every entry known, none repeated. Returns it in SCOPES order. */
export function parseScopes(values: readonly unknown[]): { ok: true; scopes: Scope[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const v of values) {
    if (!isScope(v)) return { ok: false, error: `unknown scope ${JSON.stringify(v)}` };
    if (seen.has(v)) return { ok: false, error: `scope ${v} listed twice` };
    seen.add(v);
  }
  return { ok: true, scopes: SCOPES.filter((s) => seen.has(s)) };
}

export interface Member {
  id: string;
  isOwner: boolean;
  active: boolean;
  /** profiles.scopes. Ignored for the owner. */
  scopes: readonly string[];
}

/** The known scopes stored on a member, in SCOPES order (ignores active / owner). */
function storedScopes(m: Member): Scope[] {
  const own = new Set(m.scopes);
  return SCOPES.filter((s) => own.has(s));
}

/** Everything for the owner, nothing when deactivated, otherwise exactly what was ticked (unknown values ignored). */
export function memberScopes(m: Member): Scope[] {
  if (!m.active) return [];
  if (m.isOwner) return [...SCOPES];
  return storedScopes(m);
}

export function hasScope(m: Member, scope: Scope): boolean {
  return memberScopes(m).includes(scope);
}

/** Every scope in `needed` (for a caller that carries its resolved scope list, e.g. the AI tools). */
export function can(caller: { scopes: readonly Scope[] }, ...needed: Scope[]): boolean {
  return needed.every((s) => caller.scopes.includes(s));
}

/** Reach: may this member see every row of the area, or only their own? */
export function canSeeAll(m: Member, area: "leads" | "campaigns" | "unibox" | "dashboard"): boolean {
  return hasScope(m, `${area}:all` as Scope);
}

/**
 * "Lead owner": who receives auto-assigned leads, appears in the "assign to"
 * lists, owns a territory and counts as an owner of a shared campaign. Same
 * people as the old `role = 'employee'`: not the owner, ticked leads:read but
 * not leads:all. Like the old role it ignores `active` — callers that only want
 * active people (pickers, round robin) filter on is_active as they did before.
 * Mirrored in SQL by public.kuber_is_lead_owner.
 */
export function isLeadOwner(m: Member): boolean {
  if (m.isOwner) return false;
  const s = storedScopes(m);
  return s.includes("leads:read") && !s.includes("leads:all");
}

type Verdict = { ok: true } | { ok: false; error: string };

/**
 * May `granter` edit `target` at all (name, password, territory, mailbox,
 * availability, active)? Scopes themselves go through canGrant.
 * Owner: anyone. Others need team:write and may edit themselves and members who
 * do not manage the team AND hold no scope the editor lacks (a manager edits
 * employees, never a peer manager or someone with more access).
 */
export function canManage(granter: Member, target: Member): Verdict {
  if (!granter.active) return { ok: false, error: "Your access is off." };
  if (granter.isOwner) return { ok: true };
  if (target.isOwner) return { ok: false, error: "Only the owner can change the owner." };
  if (!hasScope(granter, "team:write")) {
    return { ok: false, error: "You need the team:write permission for this. Ask the owner to add it." };
  }
  if (granter.id === target.id) return { ok: true };
  const targetScopes = storedScopes(target);
  if (targetScopes.includes("team:write")) {
    return { ok: false, error: "Only the owner can change a member who manages the team." };
  }
  // A password reset or reactivation is a takeover of that account, so you may only
  // touch people who hold nothing you don't (security review 16 Nov 2026).
  const held = new Set(memberScopes(granter));
  const beyond = targetScopes.filter((s) => !held.has(s));
  if (beyond.length) {
    return { ok: false, error: `Only the owner can change a member who has permissions you don't (${beyond.join(", ")}).` };
  }
  return { ok: true };
}

/**
 * No escalation: may `granter` set `next` as the scopes of `target`?
 * (For a new member pass a target with no scopes.)
 *  - nobody changes the owner or their own scopes;
 *  - a non-owner needs team:write, may not touch a member who holds team:write,
 *    may not give out team:write, and may only ADD or REMOVE scopes they hold
 *    themselves — so they cannot strip a peer's scope they could not grant.
 */
export function canGrant(granter: Member, target: Member, next: readonly Scope[]): Verdict {
  if (!granter.active) return { ok: false, error: "Your access is off." };
  if (target.isOwner) return { ok: false, error: "Nobody can change the owner's permissions." };
  if (granter.id === target.id) return { ok: false, error: "You cannot change your own permissions." };
  if (granter.isOwner) return { ok: true };
  const managed = canManage(granter, target);
  if (!managed.ok) return managed;
  if (next.includes("team:write")) return { ok: false, error: "Only the owner can give the team:write permission." };
  const before = new Set(storedScopes(target));
  const after = new Set(next);
  const changed = SCOPES.filter((s) => before.has(s) !== after.has(s));
  const held = new Set(memberScopes(granter));
  const missing = changed.filter((s) => !held.has(s));
  return missing.length
    ? { ok: false, error: `You can only add or remove permissions you hold yourself (not ${missing.join(", ")}).` }
    : { ok: true };
}

/** 403 text for a missing scope. */
export function missingScopeMessage(scope: Scope): string {
  return `You need the ${scope} permission for this. Ask the owner to add it.`;
}
