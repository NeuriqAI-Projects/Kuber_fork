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
// Supabase Free caps one file at 50 MB. The real limit is the 5 GB/month download
// quota: every recipient who opens a link downloads the file from our bucket.
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;

/** One file in campaigns.attachments / campaign_leads.attachments (jsonb). */
export const StoredAttachmentSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(300),
  mime: z.string(),
  size: z.number().int(),
});
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

/** First line of the links block appended to an opening email. Also how a
 *  revision finds and drops the old block before the AI sees the body. */
export const FILES_BLOCK_LABEL = "Attached files:";

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Instantly cannot send real files, so each one is a download link at the end of the email. */
export function filesBlockHtml(files: { name: string; size: number; url: string }[]): string {
  if (files.length === 0) return "";
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const links = files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a> (${formatBytes(f.size)})`);
  return `<p>${FILES_BLOCK_LABEL}<br>${links.join("<br>")}</p>`;
}

/** Step 1 body: what the browser is about to upload. Step 2 body: where it put it. */
export const AttachmentStartSchema = z.object({
  name: z.string().min(1).max(300),
  type: z.string(),
  size: z.number().int().positive(),
  /** SHA-256 of the file (hex), computed in the browser: the same file is stored once. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  if (size > ATTACHMENT_MAX_BYTES) return "File exceeds 25 MB limit";
  return null;
}

/** Every new upload lives under this company's folder; finish calls must point inside it. */
export function uploadPrefix(companyId: string | null) {
  return `uploads/${companyId ?? "shared"}/`;
}

/**
 * Step 1. Path = uploads/<company>/<sha256>/<name>, so the same file (same bytes,
 * same name) uploaded again for another campaign, lead or reply reuses the stored
 * copy: { exists: true } and the browser skips the upload. Many rows can point
 * at one object, so a single row never deletes it; the daily cleanup
 * (/api/internal/cleanup-attachments) removes it once nothing uses it.
 */
export async function startAttachmentUpload(
  db: SupabaseClient,
  companyId: string | null,
  start: z.infer<typeof AttachmentStartSchema>,
): Promise<{ path: string; token: string | null; exists: boolean }> {
  const path = `${uploadPrefix(companyId)}${start.sha256 ?? crypto.randomUUID()}/${safeFileName(start.name)}`;
  const bucket = db.storage.from(ATTACHMENT_BUCKET);
  let upsert = false;
  if (start.sha256) {
    const { data: info } = await bucket.info(path);
    if (info) {
      // The cleanup keeps anything written in the last day. A copy older than
      // half a day is uploaded again over itself (upsert -> fresh updated_at),
      // so it can't be cleaned away while a modal that just picked it is open.
      const touched = Date.parse(String((info as { updatedAt?: string }).updatedAt ?? info.createdAt ?? ""));
      if (Date.now() - touched < 12 * 3600_000) return { path, token: null, exists: true };
      upsert = true;
    }
  }
  const { data, error } = await bucket.createSignedUploadUrl(path, { upsert });
  if (error || !data) throw new Error(error?.message ?? "Could not start the upload");
  return { path: data.path, token: data.token, exists: false };
}

/** Step 2 guard: the path must be one step 1 could have handed this company. */
export function isOwnUploadPath(path: string, companyId: string | null) {
  return path.startsWith(uploadPrefix(companyId)) && !path.includes("..");
}

/**
 * 1-year download link (it sits in sent emails; Instantly has no attachment API).
 * `download` makes the browser save it under the real name ("Plant photo.png"),
 * not the storage key ("Plant_photo.png").
 */
export async function signFileLink(db: SupabaseClient, f: { path: string; name: string }): Promise<string | null> {
  const { data } = await db.storage.from(ATTACHMENT_BUCKET)
    .createSignedUrl(f.path, 60 * 60 * 24 * 365, { download: f.name });
  return data?.signedUrl ?? null;
}

/** After the browser uploaded: read the real size/type from Storage (never trust the client) and sign a 1-year link. */
export async function finishAttachmentUpload(db: SupabaseClient, path: string, name: string) {
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
  return { mime, size, url: await signFileLink(db, { path, name }) };
}

const FILES_BLOCK_RE = new RegExp(`<p[^>]*>\\s*${FILES_BLOCK_LABEL}[\\s\\S]*?</p>`);

/** Swap the "Attached files:" paragraph for `block` (append it when there is none; `block` "" removes it). */
export function replaceFilesBlock(body: string, block: string): string {
  return FILES_BLOCK_RE.test(body) ? body.replace(FILES_BLOCK_RE, block) : body + block;
}

/**
 * After a campaign's or a lead's files change: rewrite the file links in opening
 * drafts that Instantly does not have yet (no AI, no credits). Drafts already
 * handed to Instantly are left alone. With `campaignLeadId` only that lead;
 * otherwise every lead that uses the campaign's files (no files of its own).
 * The AI wording ("our brochure") is not rewritten; regenerate for that.
 */
export async function refreshDraftFileLinks(
  db: SupabaseClient,
  campaignId: string,
  campaignLeadId?: string,
): Promise<number> {
  const { data: campaign } = await db.from("campaigns").select("attachments").eq("id", campaignId).maybeSingle();
  let q = db.from("campaign_leads")
    .select("id, attachments, draft_id")
    .eq("campaign_id", campaignId)
    .in("crm_status", ["new", "enriched", "draft", "approved"])
    .is("instantly_lead_id", null)
    .not("draft_id", "is", null);
  if (campaignLeadId) q = q.eq("id", campaignLeadId);
  const { data: rows } = await q;

  const campaignFiles = (campaign?.attachments ?? []) as StoredAttachment[];
  const filesByDraft = new Map<string, StoredAttachment[]>();
  for (const r of rows ?? []) {
    const own = (r.attachments ?? []) as StoredAttachment[];
    if (!campaignLeadId && own.length) continue; // the lead's own files win
    filesByDraft.set(r.draft_id as string, own.length ? own : campaignFiles);
  }
  if (filesByDraft.size === 0) return 0;

  const urls = new Map<string, string | null>();
  const blockFor = async (files: StoredAttachment[]) => {
    const linked: { name: string; size: number; url: string }[] = [];
    for (const f of files) {
      if (!urls.has(f.path)) urls.set(f.path, await signFileLink(db, f));
      const url = urls.get(f.path);
      if (url) linked.push({ name: f.name, size: f.size, url });
    }
    return filesBlockHtml(linked);
  };

  let updated = 0;
  const ids = [...filesByDraft.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: drafts } = await db.from("email_drafts")
      .select("id, body")
      .in("id", ids.slice(i, i + 200))
      .eq("step_number", 1)
      .in("status", ["draft", "approved"]);
    const work = (drafts ?? []).map(async (d) => {
      const body = replaceFilesBlock((d.body as string | null) ?? "", await blockFor(filesByDraft.get(d.id as string) ?? []));
      if (body === d.body) return;
      const { error } = await db.from("email_drafts").update({ body, updated_at: new Date().toISOString() }).eq("id", d.id);
      if (!error) updated++;
    });
    // ponytail: 20 updates at a time; a 1000-lead campaign takes a few seconds.
    for (let j = 0; j < work.length; j += 20) await Promise.all(work.slice(j, j + 20));
  }
  return updated;
}
