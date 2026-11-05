import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { normalizeReplyBodyHtml } from "@/lib/reply-body-html";
import { assertReplyDraftAccess } from "@/lib/auth/scope";
import { z } from "zod";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const PatchSchema = z.object({
  action: z.enum(["edit", "approve", "reject"]),
  subject: z.string().optional(),
  body: z.string().optional(),
  rejection_reason: z.string().optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertReplyDraftAccess(db, user, id); } catch (r) { return r as Response; }
  const { data } = await db.from("reply_drafts").select("*").eq("id", id).maybeSingle();
  if (!data) return fail(404, "NOT_FOUND", "Reply draft not found");
  return ok(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const db = dbForUser(user);
  try { await assertReplyDraftAccess(db, user, id); } catch (r) { return r as Response; }
  const now = new Date().toISOString();
  const p = parsed.data;

  if (p.action === "edit") {
    const body = p.body ? normalizeReplyBodyHtml(p.body) : p.body;
    await db.from("reply_drafts").update({
      subject: p.subject, body, updated_at: now,
    }).eq("id", id);
  } else if (p.action === "approve") {
    const body = p.body ? normalizeReplyBodyHtml(p.body) : p.body;
    await db.from("reply_drafts").update({
      status: "approved", reviewed_by: user.id, approved_at: now, updated_at: now,
      ...(p.subject ? { subject: p.subject } : {}),
      ...(body ? { body } : {}),
    }).eq("id", id);
  } else if (p.action === "reject") {
    await db.from("reply_drafts").update({
      status: "rejected", reviewed_by: user.id, error: p.rejection_reason ?? null, updated_at: now,
    }).eq("id", id);
  }
  const { data } = await db.from("reply_drafts").select("*").eq("id", id).maybeSingle();
  return ok(data);
}
