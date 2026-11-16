import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess, assertCampaignLeadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import {
  AttachmentFinishSchema, AttachmentStartSchema, checkAttachment, finishAttachmentUpload,
  safeFileName, signAttachmentUpload,
} from "@/lib/services/attachment-upload";

export const maxDuration = 30;

/**
 * POST = set/replace the per-lead attachment override, in two calls (the file
 * itself never passes through here; Vercel caps bodies at 4.5 MB):
 *  1. { name, type, size }          -> { path, token } signed upload URL; the browser uploads to Storage
 *  2. { finish: true, path, name }  -> saves the override on the campaign lead
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);

  const { data: cl } = await db.from("campaign_leads").select("campaign_id").eq("id", id).maybeSingle();
  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");
  try {
    await assertCampaignAccess(db, user, cl.campaign_id);
    // Per-lead action: without campaigns:all, only a lead assigned to the caller.
    await assertCampaignLeadAccess(db, user, id);
  } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const finish = AttachmentFinishSchema.safeParse(body);
  if (finish.success) {
    const { path, name } = finish.data;
    if (!path.startsWith(`campaign-leads/${id}/`) || path.includes("..")) return fail(400, "VALIDATION_ERROR", "Bad upload path");
    let f: Awaited<ReturnType<typeof finishAttachmentUpload>>;
    try { f = await finishAttachmentUpload(db, path); } catch (e) { return fail(400, "VALIDATION_ERROR", (e as Error).message); }

    const { error: updErr } = await db.from("campaign_leads").update({
      attachment_path: path,
      attachment_name: name,
      attachment_mime: f.mime,
      attachment_size: f.size,
      attachment_url: f.url,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (updErr) return fail(500, "INTERNAL", updErr.message);

    return ok({ attachment_name: name, attachment_size: f.size, attachment_mime: f.mime, attachment_url: f.url });
  }

  const start = AttachmentStartSchema.safeParse(body);
  if (!start.success) return fail(400, "VALIDATION_ERROR", "Invalid request", start.error.flatten());
  const bad = checkAttachment(start.data.type, start.data.size);
  if (bad) return fail(400, "VALIDATION_ERROR", bad);
  try {
    return ok(await signAttachmentUpload(db, `campaign-leads/${id}/${crypto.randomUUID()}-${safeFileName(start.data.name)}`));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}

/** DELETE = clear the per-lead override → fall back to the campaign default */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);

  // best-effort remove the stored object
  const { data: row } = await db.from("campaign_leads")
    .select("attachment_path, campaign_id").eq("id", id).maybeSingle();
  if (!row) return fail(404, "NOT_FOUND", "Campaign lead not found");
  try {
    await assertCampaignAccess(db, user, row.campaign_id);
    await assertCampaignLeadAccess(db, user, id);
  } catch (r) { return r as Response; }
  if (row?.attachment_path) {
    await db.storage.from("campaign-attachments").remove([row.attachment_path]).catch(() => {});
  }

  const { error } = await db.from("campaign_leads").update({
    attachment_path: null, attachment_name: null, attachment_mime: null,
    attachment_size: null, attachment_url: null, updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ cleared: true });
}
