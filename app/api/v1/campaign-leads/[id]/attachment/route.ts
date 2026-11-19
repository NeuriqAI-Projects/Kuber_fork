import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess, assertCampaignLeadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import {
  ATTACHMENT_MAX_FILES, AttachmentFinishSchema, AttachmentStartSchema, checkAttachment, finishAttachmentUpload,
  isOwnUploadPath, refreshDraftFileLinks, startAttachmentUpload, type StoredAttachment,
} from "@/lib/services/attachment-upload";

export const maxDuration = 30;

/**
 * POST = add one file to this lead's own files (max 5; while the lead has any,
 * they replace the campaign's files). Two calls, the file itself never passes
 * through here (Vercel caps bodies at 4.5 MB):
 *  1. { name, type, size }          -> { path, token } signed upload URL; the browser uploads to Storage
 *  2. { finish: true, path, name }  -> appends the file to campaign_leads.attachments
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);

  const { data: cl } = await db.from("campaign_leads").select("campaign_id, attachments").eq("id", id).maybeSingle();
  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");
  try {
    await assertCampaignAccess(db, user, cl.campaign_id);
    // Per-lead action: without campaigns:all, only a lead assigned to the caller.
    await assertCampaignLeadAccess(db, user, id);
  } catch (r) { return r as Response; }

  const files = (cl.attachments ?? []) as StoredAttachment[];
  const body = await req.json().catch(() => null);
  const finish = AttachmentFinishSchema.safeParse(body);
  if (finish.success) {
    const { path, name } = finish.data;
    if (!isOwnUploadPath(path, user.companyId)) return fail(400, "VALIDATION_ERROR", "Bad upload path");
    if (files.some((x) => x.path === path)) return fail(400, "VALIDATION_ERROR", "This file is already attached to this lead");
    let f: Awaited<ReturnType<typeof finishAttachmentUpload>>;
    try { f = await finishAttachmentUpload(db, path, name); } catch (e) { return fail(400, "VALIDATION_ERROR", (e as Error).message); }

    if (files.length >= ATTACHMENT_MAX_FILES) {
      return fail(400, "VALIDATION_ERROR", `Up to ${ATTACHMENT_MAX_FILES} files per lead`);
    }
    // ponytail: read-then-write; two uploads finishing at the same instant can drop one. Fine for a manual button.
    const { error: updErr } = await db.from("campaign_leads").update({
      attachments: [...files, { path, name, mime: f.mime, size: f.size }],
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (updErr) return fail(500, "INTERNAL", updErr.message);

    const drafts_updated = await refreshDraftFileLinks(db, cl.campaign_id, id);
    return ok({ attachment_name: name, attachment_size: f.size, attachment_mime: f.mime, attachment_url: f.url, drafts_updated });
  }

  const start = AttachmentStartSchema.safeParse(body);
  if (!start.success) return fail(400, "VALIDATION_ERROR", "Invalid request", start.error.flatten());
  if (files.length >= ATTACHMENT_MAX_FILES) return fail(400, "VALIDATION_ERROR", `Up to ${ATTACHMENT_MAX_FILES} files per lead`);
  const bad = checkAttachment(start.data.type, start.data.size);
  if (bad) return fail(400, "VALIDATION_ERROR", bad);
  try {
    return ok(await startAttachmentUpload(db, user.companyId, start.data));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}

/** DELETE ?path=… removes one of the lead's files; no path clears them all (back to the campaign's files). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);

  // best-effort remove the stored object
  const { data: row } = await db.from("campaign_leads")
    .select("attachments, campaign_id").eq("id", id).maybeSingle();
  if (!row) return fail(404, "NOT_FOUND", "Campaign lead not found");
  try {
    await assertCampaignAccess(db, user, row.campaign_id);
    await assertCampaignLeadAccess(db, user, id);
  } catch (r) { return r as Response; }
  const one = req.nextUrl.searchParams.get("path");
  const files = (row.attachments ?? []) as StoredAttachment[];
  // Only the row changes: the stored file may be shared with other campaigns or
  // linked from sent mail. The daily cleanup deletes it once nothing uses it.
  const { error } = await db.from("campaign_leads").update({
    attachments: one ? files.filter((f) => f.path !== one) : [],
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  // Back on the campaign's files (or one fewer of its own): fix the unsent draft's links.
  const drafts_updated = await refreshDraftFileLinks(db, row.campaign_id, id);
  return ok({ cleared: true, drafts_updated });
}
