import { NextRequest } from "next/server";
import { requireScope, assertScope, forgetProfile } from "@/lib/auth/api-auth";
import { canGrant, canManage, isLeadOwner, parseScopes, SCOPES, type Member, type Scope } from "@/lib/auth/scopes";
import { ok, fail } from "@/lib/api-response";
import { PatchUserSchema } from "@/lib/validators/users";
import { canonicalCountryList } from "@/lib/territory";
import {
  handoverEmployeeWork,
  NoEligibleEmployeesError,
  InvalidHandoverTargetError,
  type HandoverStrategy,
  type HandoverSummary,
} from "@/lib/services/handover";
import { listInstantlyAccounts } from "@/lib/services/instantly";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let caller: Awaited<ReturnType<typeof requireScope>>;
  try { caller = await requireScope(req, "team:write"); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchUserSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { password, territory_countries, full_name, is_active, availability_status, reassign_to, handover_strategy, sending_email } = parsed.data;

  const db = dbForUser(caller);

  const { data: existing, error: existingErr } = await db
    .from("profiles")
    .select("id, is_owner, scopes, is_active")
    .eq("id", id)
    .maybeSingle();
  if (existingErr) return fail(500, "INTERNAL", existingErr.message);
  if (!existing) return fail(404, "NOT_FOUND", "User not found");
  const target: Member = {
    id: existing.id as string,
    isOwner: !!existing.is_owner,
    active: !!existing.is_active,
    scopes: (existing.scopes as string[] | null) ?? [],
  };

  // The owner's active status is locked — nobody, the owner included, can
  // deactivate them through this endpoint (their scopes are locked by canGrant).
  if (target.isOwner && is_active === false) {
    return fail(400, "VALIDATION_ERROR", "The owner's account cannot be deactivated.");
  }

  // Nobody can deactivate their own account — there'd be no one left to undo
  // it once they're locked out.
  if (target.id === caller.id && is_active === false) {
    return fail(400, "VALIDATION_ERROR", "You cannot deactivate your own account.");
  }

  // Members with team:write manage themselves and members who don't manage the
  // team. Anything about a peer who holds team:write — scopes, password,
  // activation, profile — is reserved for the owner, so nobody can lock out or
  // take over a peer (planning.md D5/Q3; lib/auth/scopes.ts canManage).
  const managed = canManage(caller.member, target);
  if (!managed.ok) return fail(403, "FORBIDDEN", managed.error);

  // Scopes: only a real change is checked and written (sending the same list
  // back, e.g. from a full form save on your own row, is a no-op, as an
  // unchanged role was before). canGrant = the no-escalation rules.
  let nextScopes: Scope[] | undefined;
  if (parsed.data.scopes !== undefined) {
    const scopes = parseScopes(parsed.data.scopes);
    if (!scopes.ok) return fail(400, "VALIDATION_ERROR", scopes.error);
    const stored = SCOPES.filter((s) => target.scopes.includes(s));
    if (scopes.scopes.join() !== stored.join()) {
      const verdict = canGrant(caller.member, target, scopes.scopes);
      if (!verdict.ok) return fail(403, "FORBIDDEN", verdict.error);
      nextScopes = scopes.scopes;
    }
  }

  // Deactivating someone who still holds leads/campaigns requires the caller
  // to explicitly say where that work goes — no silent orphaning, and no
  // auto-guessed handover either. They may hand it to one named successor,
  // release it to the manager pool, or redistribute it round-robin / by
  // territory across the rest of the team.
  //
  // Deliberately runs BEFORE the account is actually deactivated: if the
  // handover fails, the worst outcome is "nothing moved and the account is
  // still active" — visible and retryable. Deactivating first would risk
  // leaving a book stranded on a locked-out account. The departing user is
  // excluded from every candidate list inside the service, so the window in
  // which they are still active cannot route their own leads back to them.
  let handover: HandoverSummary | undefined;
  if (is_active === false) {
    const [{ count: heldCampaigns }, { count: heldLeads }] = await Promise.all([
      db.from("campaigns").select("id", { count: "exact", head: true }).eq("assigned_to", id).eq("is_deleted", false),
      db.from("leads").select("id", { count: "exact", head: true }).eq("assigned_to", id).eq("is_deleted", false),
    ]);

    if ((heldCampaigns ?? 0) > 0 || (heldLeads ?? 0) > 0) {
      // A bare reassign_to (no strategy) is the pre-handover contract: one
      // named successor takes everything.
      const strategy: HandoverStrategy | undefined = handover_strategy ?? (reassign_to ? "manual" : undefined);

      if (!strategy) {
        return fail(
          400,
          "REASSIGN_REQUIRED",
          "This user still holds leads/campaigns. Choose where that work goes before deactivating.",
          { held_campaigns: heldCampaigns ?? 0, held_leads: heldLeads ?? 0 },
        );
      }

      // Handing work to people is an assignment (security review 16 Nov 2026): it
      // needs the same scopes as bulk-assign / campaign assign. Releasing it to
      // the pool assigns nobody, so team:write alone may do that.
      if (strategy !== "pool") {
        try {
          if ((heldLeads ?? 0) > 0) assertScope(caller, "leads:assign");
          if ((heldCampaigns ?? 0) > 0) assertScope(caller, "campaigns:assign");
        } catch (r) { return r as Response; }
      }

      try {
        handover = await handoverEmployeeWork(db, id, strategy, reassign_to ?? null, caller.id);
      } catch (e) {
        if (e instanceof NoEligibleEmployeesError) {
          // Same contract as the leads bulk-assign endpoint. Silently pooling
          // everything when the manager asked for round-robin would be a
          // surprise; the pool has to be an explicit choice.
          return fail(409, "NO_ELIGIBLE_EMPLOYEES", e.message, {
            held_campaigns: heldCampaigns ?? 0,
            held_leads: heldLeads ?? 0,
          });
        }
        if (e instanceof InvalidHandoverTargetError) {
          return fail(400, "INVALID_ASSIGNEE", e.message);
        }
        return fail(500, "INTERNAL", (e as Error).message);
      }
    }
  }

  if (password || is_active !== undefined) {
    // Deactivation must also block Supabase Auth itself — banning stops both new
    // sign-ins and refresh-token renewal, so a deactivated user can't log back in
    // and loses access once their current access token expires.
    const { error: authError } = await db.auth.admin.updateUserById(id, {
      ...(password ? { password } : {}),
      ...(is_active !== undefined ? { ban_duration: is_active ? "none" : "876000h" } : {}),
    });
    if (authError) return fail(400, "USER_UPDATE_FAILED", authError.message);
  }

  // A mailbox that isn't connected in Instantly (or can't send) would not fail
  // here — it would fail much later, when a campaign built around it is created,
  // by which time the caller has moved on. Check it at the point of assignment.
  let normalizedSender: string | null | undefined = sending_email;
  if (sending_email) {
    let accounts: Awaited<ReturnType<typeof listInstantlyAccounts>>;
    try {
      accounts = await listInstantlyAccounts();
    } catch (e) {
      return fail(502, "INSTANTLY_ERROR", (e as Error).message);
    }
    const match = accounts.find((a) => a.email.toLowerCase() === sending_email.toLowerCase());
    if (!match) return fail(400, "ACCOUNT_NOT_FOUND", "That mailbox is not connected in Instantly");
    if (match.status !== 1) {
      return fail(400, "ACCOUNT_CANNOT_SEND", `${match.email} cannot send right now (status ${match.status})`);
    }
    normalizedSender = match.email.toLowerCase();
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // null clears the assignment — that person falls back to the company default.
  if (normalizedSender !== undefined) patch.sending_email = normalizedSender;
  if (full_name !== undefined) patch.full_name = full_name;
  if (nextScopes !== undefined) patch.scopes = nextScopes;
  // Territory only means something for a lead owner (leads:read without
  // leads:all — who receives leads); everyone else is saved with none.
  if (territory_countries !== undefined) {
    const leadOwner = isLeadOwner({ ...target, scopes: nextScopes ?? target.scopes });
    patch.territory_countries = leadOwner ? canonicalCountryList(territory_countries) : [];
  }
  if (is_active !== undefined) patch.is_active = is_active;
  // Online/offline availability (spec §2B) — someone with team:write marking a member
  // temporarily unavailable (leave/vacation). Distinct from is_active.
  if (availability_status !== undefined) patch.availability_status = availability_status;

  const { data, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select("id, email, full_name, territory_countries, is_active, availability_status, sending_email, created_at, is_owner, scopes")
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  // Scope / access changes reach this instance's auth now; others within 30 s.
  if (nextScopes !== undefined || is_active !== undefined) forgetProfile(id);

  // `handover` rides along on the profile so the caller can report the actual
  // split ("620 leads to 3 people, 380 to the pool") rather than guessing.
  return ok(handover ? { ...data, handover } : data);
}
