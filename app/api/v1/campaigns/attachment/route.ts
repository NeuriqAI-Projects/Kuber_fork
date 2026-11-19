import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import {
  AttachmentFinishSchema, AttachmentStartSchema, checkAttachment, finishAttachmentUpload,
  isOwnUploadPath, startAttachmentUpload,
} from "@/lib/services/attachment-upload";

export const maxDuration = 30;

/**
 * Two calls, the file itself never passes through here (Vercel caps bodies at 4.5 MB):
 *  1. { name, type, size, sha256 }    -> { path, token, exists } signed upload URL; the browser uploads to Storage
 *                                        (exists = this file is already stored, skip the upload)
 *  2. { finish: true, path, name }    -> attachment fields + 1-year signed link
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "campaigns:write"); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const body = await req.json().catch(() => null);

  const finish = AttachmentFinishSchema.safeParse(body);
  if (finish.success) {
    const { path, name } = finish.data;
    if (!isOwnUploadPath(path, user.companyId)) return fail(400, "VALIDATION_ERROR", "Bad upload path");
    try {
      const f = await finishAttachmentUpload(db, path);
      return ok({ attachment_path: path, attachment_name: name, attachment_mime: f.mime, attachment_size: f.size, attachment_url: f.url });
    } catch (e) {
      return fail(400, "VALIDATION_ERROR", (e as Error).message);
    }
  }

  const start = AttachmentStartSchema.safeParse(body);
  if (!start.success) return fail(400, "VALIDATION_ERROR", "Invalid request", start.error.flatten());
  const bad = checkAttachment(start.data.type, start.data.size);
  if (bad) return fail(400, "VALIDATION_ERROR", bad);
  try {
    return ok(await startAttachmentUpload(db, user.companyId, start.data));
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
