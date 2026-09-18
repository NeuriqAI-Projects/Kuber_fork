import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { internalAppBaseUrl } from "@/lib/internal-url";

/**
 * Re-kick a bulk regeneration whose batch chain has died.
 *
 * The worker re-triggers itself batch to batch, and the platform drops that
 * chain after about five hops — measured four times on 18 Sep 2026, with two
 * different hand-off designs. A request from the browser starts a fresh chain.
 * The drawer calls this while it is polling a job that has gone quiet, so a
 * dead link costs about a minute for whoever is watching, instead of waiting
 * on the ten-minute watchdog.
 *
 * Sends no job id: the worker's pump mode picks up any job with no heartbeat
 * for a minute and ignores one that is still moving, so this cannot start a
 * second batch on a live chain however often it is pressed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return fail(500, "INTERNAL", "Internal secret not configured");

  const res = await fetch(`${internalAppBaseUrl(req)}/api/enrich/regenerate-drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: "{}",
  }).catch(() => null);

  return ok({ kicked: res?.status === 202 });
}
