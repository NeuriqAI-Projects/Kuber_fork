import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Attachments go browser -> Supabase Storage directly (signed upload URL).
// Sending the file through our API broke anything over 4.5 MB: Vercel rejects
// bigger request bodies before the route runs. The bucket enforces the same
// size and type limits on its side.
export const ATTACHMENT_BUCKET = "campaign-attachments";
export const ATTACHMENT_ALLOWED = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png", "image/jpeg",
]);
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Step 1 body: what the browser is about to upload. Step 2 body: where it put it. */
export const AttachmentStartSchema = z.object({
  name: z.string().min(1).max(300),
  type: z.string(),
  size: z.number().int().positive(),
});
export const AttachmentFinishSchema = z.object({
  finish: z.literal(true),
  path: z.string().min(1),
  name: z.string().min(1).max(300),
});

export function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Returns an error message, or null when the file may be uploaded. */
export function checkAttachment(type: string, size: number): string | null {
  if (!ATTACHMENT_ALLOWED.has(type)) return `Unsupported file type: ${type || "unknown"}`;
  if (size > ATTACHMENT_MAX_BYTES) return "File exceeds 10MB limit";
  return null;
}

export async function signAttachmentUpload(db: SupabaseClient, path: string) {
  const { data, error } = await db.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "Could not start the upload");
  return { path: data.path, token: data.token };
}

/** After the browser uploaded: read the real size/type from Storage (never trust the client) and sign a 1-year link. */
export async function finishAttachmentUpload(db: SupabaseClient, path: string) {
  const bucket = db.storage.from(ATTACHMENT_BUCKET);
  const { data: info, error } = await bucket.info(path);
  if (error || !info) throw new Error("Uploaded file not found");
  const mime = info.contentType ?? "";
  const size = info.size ?? 0;
  const bad = checkAttachment(mime, size);
  if (bad) {
    await bucket.remove([path]).catch(() => {});
    throw new Error(bad);
  }
  // 1 year: the link is embedded in sent emails (Instantly has no attachment
  // API), so recipients must be able to open it long after send.
  const { data: signed } = await bucket.createSignedUrl(path, 60 * 60 * 24 * 365);
  return { mime, size, url: signed?.signedUrl ?? null };
}
