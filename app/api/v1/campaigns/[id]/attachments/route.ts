import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess, assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { CampaignAttachmentsSchema } from "@/lib/validators/campaigns";
import {
  ATTACHMENT_BUCKET, ATTACHMENT_MAX_FILES, checkAttachment, isOwnUploadPath, refreshDraftFileLinks, type StoredAttachment,
} from "@/lib/services/attachment-upload";

export const maxDuration = 60;

/** GET = the campaign's files (Options tab). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:read"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  let row: Record<string, unknown>;
  try { row = await assertCampaignAccess(db, user, id, "attachments"); } catch (r) { return r as Response; }
  return ok({ attachments: (row.attachments ?? []) as StoredAttachment[] });
}

/**
 * PUT { attachments } = replace the campaign's file list (max 5). New files come
 * from /api/v1/campaigns/attachment; their size/type is re-read from Storage.
 * Then the links in opening drafts Instantly does not have yet are rewritten.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  const parsed = CampaignAttachmentsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { data: campaign } = await db.from("campaigns").select("attachments, is_deleted").eq("id", id).maybeSingle();
  if (!campaign || campaign.is_deleted) return fail(404, "NOT_FOUND", "Campaign not found");
  const current = new Map(((campaign.attachments ?? []) as StoredAttachment[]).map((f) => [f.path, f]));

  const next: StoredAttachment[] = [];
  for (const f of parsed.data.attachments) {
    if (next.some((x) => x.path === f.path)) continue;
    if (next.length >= ATTACHMENT_MAX_FILES) return fail(400, "VALIDATION_ERROR", `Up to ${ATTACHMENT_MAX_FILES} files per campaign`);
    const kept = current.get(f.path);
    if (kept) { next.push(kept); continue; } // older files may sit outside the company folder
    if (!isOwnUploadPath(f.path, user.companyId)) return fail(400, "VALIDATION_ERROR", "Bad attachment path");
    const { data: info } = await db.storage.from(ATTACHMENT_BUCKET).info(f.path);
    if (!info) return fail(400, "VALIDATION_ERROR", `${f.name} was not uploaded`);
    const bad = checkAttachment(info.contentType ?? "", info.size ?? 0);
    if (bad) return fail(400, "VALIDATION_ERROR", bad);
    next.push({ path: f.path, name: f.name, mime: info.contentType ?? "", size: info.size ?? 0 });
  }

  const { error } = await db.from("campaigns")
    .update({ attachments: next, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  const drafts_updated = await refreshDraftFileLinks(db, id);
  return ok({ attachments: next, drafts_updated });
}
