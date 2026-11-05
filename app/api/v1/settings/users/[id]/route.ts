import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
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
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchUserSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { password, role, territory_countries, full_name, is_active, availability_status, reassign_to, handover_strategy, sending_email } = parsed.data;

  const db = dbForUser(caller);

  const { data: existing, error: existingErr } = await db
    .from("profiles")
    .select("id, role, is_super_admin")
    .eq("id", id)
    .maybeSingle();
  if (existingErr) return fail(500, "INTERNAL", existingErr.message);
  if (!existing) return fail(404, "NOT_FOUND", "User not found");

  // The Super Admin's own role and active status are locked — nobody, including
  // the Super Admin themselves, can change them through this endpoint.
  if (existing.is_super_admin) {
    if (role !== undefined && role !== existing.role) {
      return fail(400, "VALIDATION_ERROR", "The Super Admin's role cannot be changed.");
    }
    if (is_active === false) {
      return fail(400, "VALIDATION_ERROR", "The Super Admin account cannot be deactivated.");
    }
  }

  // A manager (Super Admin or not) can never deactivate their own account —
  // there'd be no one left to undo it once they're locked out.
  if (existing.role === "manager" && existing.id === caller.id && is_active === false) {
    return fail(400, "VALIDATION_ERROR", "You cannot deactivate your own account.");
  }

  // Managers manage employees only. Anything about another manager — role,
  // password, activation, profile — is reserved for the Super Admin, so a
  // regular manager can never demote or lock out a peer (planning.md D5/Q3).
  if (!caller.isSuperAdmin) {
    if (existing.role === "manager" && existing.id !== caller.id) {
      return fail(403, "FORBIDDEN", "Only the Super Admin can manage manager accounts.");
    }
    if (role !== undefined && role !== existing.role) {
      return fail(403, "FORBIDDEN", "Only the Super Admin can change a user's role.");
    }
  }

  // Deactivating someone who still holds leads/campaigns requires the manager
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

  if (password || role || is_active !== undefined) {
    // Deactivation must also block Supabase Auth itself — banning stops both new
    // sign-ins and refresh-token renewal, so a deactivated user can't log back in
    // and loses access once their current access token expires.
    const { error: authError } = await db.auth.admin.updateUserById(id, {
      ...(password ? { password } : {}),
      ...(role ? { app_metadata: { role } } : {}),
      ...(is_active !== undefined ? { ban_duration: is_active ? "none" : "876000h" } : {}),
    });
    if (authError) return fail(400, "USER_UPDATE_FAILED", authError.message);
  }

  // A mailbox that isn't connected in Instantly (or can't send) would not fail
  // here — it would fail much later, when a campaign built around it is created,
  // by which time the manager has moved on. Check it at the point of assignment.
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
  if (role !== undefined) patch.role = role;
  if (territory_countries !== undefined) {
    patch.territory_countries =
      role === "employee" || role === undefined ? canonicalCountryList(territory_countries) : [];
  }
  if (is_active !== undefined) patch.is_active = is_active;
  // Online/offline availability (spec §2B) — a manager marking an employee
  // temporarily unavailable (leave/vacation). Distinct from is_active.
  if (availability_status !== undefined) patch.availability_status = availability_status;

  const { data, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select("id, email, full_name, role, territory_countries, is_active, availability_status, is_super_admin, sending_email, created_at")
    .single();

  if (error) return fail(500, "INTERNAL", error.message);

  // `handover` rides along on the profile so the caller can report the actual
  // split ("620 leads to 3 people, 380 to the pool") rather than guessing.
  return ok(handover ? { ...data, handover } : data);
}
