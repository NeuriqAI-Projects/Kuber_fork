import { NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth/verify-jwt";
import { createAdminClient } from "@/lib/supabase/admin";
import { memberScopes, missingScopeMessage, SCOPES, type Member, type Scope } from "@/lib/auth/scopes";
import { SERVICE_ROLE_USER_ID } from "@/lib/constants";
import { checkRateLimit, tierFor } from "@/lib/auth/rate-limit";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * `companyId` is the tenant every query must be scoped to (see
 * lib/supabase/scoped.ts). It is null only for the service-role bearer used by
 * internal server-to-server calls, which legitimately operate across companies
 * and carry company_id explicitly from the rows they process.
 */
export type AuthedUser = {
  id: string;
  email?: string;
  companyId: string | null;
  isOwner: boolean;
  /** memberScopes(member) at request time — read from profiles, never the JWT. */
  scopes: Scope[];
  member: Member;
};

function unauthorized(message: string) {
  return Response.json(
    { success: false, data: null, error: { code: "UNAUTHORIZED", message } },
    { status: 401 },
  );
}

function tooManyRequests(retryAfterSeconds: number, limit: number) {
  return Response.json(
    {
      success: false,
      data: null,
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests — the limit is ${limit} per minute. Try again in ${retryAfterSeconds}s.`,
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function forbidden(message: string) {
  return Response.json(
    { success: false, data: null, error: { code: "FORBIDDEN", message } },
    { status: 403 },
  );
}

type ProfileRow = { is_active: boolean; is_owner: boolean; scopes: string[] | null; company_id: string | null };

/** Profile rows cached per server instance for at most PROFILE_TTL_MS. */
const PROFILE_TTL_MS = 30_000;
const profileCache = new Map<string, { profile: ProfileRow; expires: number }>();

async function loadProfile(userId: string): Promise<ProfileRow | null> {
  const hit = profileCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.profile;
  const { data } = await createAdminClient()
    .from("profiles")
    .select("is_active, is_owner, scopes, company_id")
    .eq("id", userId)
    .maybeSingle();
  // Misses are not cached, so a just-provisioned user works on the next call.
  if (data) {
    if (profileCache.size > 1000) profileCache.clear();
    profileCache.set(userId, { profile: data as ProfileRow, expires: Date.now() + PROFILE_TTL_MS });
  }
  return (data as ProfileRow | null) ?? null;
}

/** Drop a member's cached profile on this instance (after their scopes / active flag change). */
export function forgetProfile(userId: string): void {
  profileCache.delete(userId);
}

/**
 * Verifies the Bearer JWT and resolves the caller's scopes from `profiles` (never the JWT)
 * so a change does not wait on token refresh. The profile row is cached per server instance
 * for 30 s, so a scope change or deactivation reaches other instances within 30 s.
 * Returns the user or throws a Response.
 */
export async function requireAuth(request: NextRequest): Promise<AuthedUser> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    throw unauthorized("Missing Authorization header");
  }

  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    // Internal server-to-server bearer: acts as an owner with every scope, across companies.
    const member: Member = { id: SERVICE_ROLE_USER_ID, isOwner: true, active: true, scopes: [] };
    return { id: SERVICE_ROLE_USER_ID, email: "admin@service", companyId: null, isOwner: true, scopes: [...SCOPES], member };
  }

  const verified = await verifyAccessToken(token);
  if (!verified) {
    throw unauthorized("Invalid or expired token");
  }

  // Only real user sessions are limited. The service-role bearer returned
  // above, and every cron job and self-chain authenticates with INTERNAL_SECRET
  // and so never reaches this function at all — which is exactly why drafting a
  // 100-lead campaign (a long sequence of internal calls) cannot be throttled
  // half way through. See lib/auth/rate-limit.ts.
  const url = new URL(request.url);
  const limited = checkRateLimit(verified.id, tierFor(url.pathname, request.method));
  if (!limited.allowed) {
    throw tooManyRequests(limited.retryAfterSeconds, limited.limit);
  }

  const profile = await loadProfile(verified.id);

  if (!profile || !profile.is_active) {
    throw unauthorized("Account is inactive or not provisioned");
  }

  // A provisioned profile always has a company (company_id is NOT NULL). Treat a
  // missing one as unprovisioned rather than falling through to an unscoped
  // client, which would expose every tenant's data.
  if (!profile.company_id) {
    throw unauthorized("Account is not assigned to a company");
  }

  const member: Member = {
    id: verified.id,
    isOwner: profile.is_owner,
    active: profile.is_active,
    scopes: profile.scopes ?? [],
  };
  return {
    id: verified.id,
    email: verified.email,
    companyId: profile.company_id as string,
    isOwner: member.isOwner,
    scopes: memberScopes(member),
    member,
  };
}

/**
 * requireAuth + the caller must hold `scope` (or be the owner, for "owner").
 * Every user-facing route handler calls this (lib/auth/access-wiring.test.mts
 * enforces it). A write handler is never guarded by a `:read` scope.
 */
export async function requireScope(request: NextRequest, scope: Scope | "owner"): Promise<AuthedUser> {
  const user = await requireAuth(request);
  const allowed = scope === "owner" ? user.isOwner : user.scopes.includes(scope);
  if (!allowed) {
    throw forbidden(scope === "owner" ? "Only the owner can do this." : missingScopeMessage(scope));
  }
  return user;
}

/**
 * requireAuth + the caller must hold AT LEAST ONE of `scopes`. For a step shared by
 * several flows (email reveal is reached from Apollo search and from Company lookup).
 * The 403 names the first scope.
 */
export async function requireAnyScope(request: NextRequest, ...scopes: [Scope, ...Scope[]]): Promise<AuthedUser> {
  const user = await requireAuth(request);
  if (!scopes.some((s) => user.scopes.includes(s))) throw forbidden(missingScopeMessage(scopes[0]));
  return user;
}

/** Throws a 403 unless the already-authed caller also holds `scope` (a second scope inside a handler). */
export function assertScope(user: AuthedUser, scope: Scope): void {
  if (!user.scopes.includes(scope)) throw forbidden(missingScopeMessage(scope));
}
