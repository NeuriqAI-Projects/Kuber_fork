import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager, requireSuperAdmin } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getSendingAccounts, SENDING_ACCOUNTS_SETTING_KEY } from "@/lib/services/service-keys";
import { listInstantlyAccounts } from "@/lib/services/instantly";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const BodySchema = z.object({
  email: z.string().trim().email("Select a valid sending account"),
});

const STATUS_LABEL: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Maintenance",
  [-1]: "Connection error",
  [-2]: "Soft-bounce error",
  [-3]: "Sending error",
};

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  try {
    const [accounts, configured] = await Promise.all([
      listInstantlyAccounts(),
      getSendingAccounts(db),
    ]);
    const selectedEmail = configured.length === 1 ? configured[0] : null;

    return ok({
      accounts: accounts.map((account) => ({
        ...account,
        status_label: STATUS_LABEL[account.status] ?? `Status ${account.status}`,
        can_send: account.status === 1,
      })),
      selected_email: selectedEmail,
      selection_required: configured.length !== 1,
    });
  } catch (e) {
    return fail(502, "INSTANTLY_ERROR", (e as Error).message);
  }
}

export async function PUT(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireSuperAdmin>>;
  try { user = await requireSuperAdmin(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  let accounts: Awaited<ReturnType<typeof listInstantlyAccounts>>;
  try {
    accounts = await listInstantlyAccounts();
  } catch (e) {
    return fail(502, "INSTANTLY_ERROR", (e as Error).message);
  }

  const selected = accounts.find(
    (account) => account.email.toLowerCase() === parsed.data.email.toLowerCase(),
  );
  if (!selected) {
    return fail(400, "ACCOUNT_NOT_FOUND", "That mailbox is not connected in Instantly");
  }
  if (selected.status !== 1) {
    return fail(
      400,
      "ACCOUNT_CANNOT_SEND",
      `${selected.email} cannot send right now (${STATUS_LABEL[selected.status] ?? `status ${selected.status}`})`,
    );
  }

  const db = dbForUser(user);
  const { error } = await db.from("settings").upsert(
    { key: SENDING_ACCOUNTS_SETTING_KEY, value: selected.email.toLowerCase() },
    { onConflict: "key" },
  );
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ selected_email: selected.email.toLowerCase() });
}
