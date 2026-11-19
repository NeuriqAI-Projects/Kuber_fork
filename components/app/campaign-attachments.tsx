"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import {
  fetchCampaignAttachments, saveCampaignAttachments, uploadCampaignAttachment, type CampaignFile,
} from "@/lib/api-client";
import { ATTACHMENT_ALLOWED, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, formatBytes } from "@/lib/services/attachment-upload";

/**
 * Options tab: the campaign's files (N / 5). Every add or remove saves at once,
 * and opening drafts Instantly does not have yet get the new links.
 */
export function CampaignAttachments({ campaignId, readOnly }: { campaignId: string; readOnly: boolean }) {
  const [files, setFiles] = useState<CampaignFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function token() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetchCampaignAttachments(await token(), campaignId);
        if (live) setFiles(r.attachments);
      } catch (e) {
        if (live) { setFiles([]); toast.error((e as Error).message); }
      }
    })();
    return () => { live = false; };
  }, [campaignId]);

  async function save(next: CampaignFile[], done: string) {
    const r = await saveCampaignAttachments(await token(), campaignId, next);
    setFiles(r.attachments);
    toast.success(r.drafts_updated
      ? `${done}. Links updated in ${r.drafts_updated} unsent draft${r.drafts_updated === 1 ? "" : "s"}`
      : done);
  }

  async function add(list: FileList | null) {
    const all = Array.from(list ?? []);
    if (!files || all.length === 0) return;
    const picked = all.filter((f) => {
      const why = f.size > ATTACHMENT_MAX_BYTES ? "is over 25 MB" : !ATTACHMENT_ALLOWED.has(f.type) ? "is not a PDF, Word, Excel, PNG or JPG file" : "";
      if (why) toast.error(`${f.name} ${why}`);
      return !why;
    });
    setBusy(true);
    try {
      const t = await token();
      const next = [...files];
      let skipped = 0;
      // Fill until 5 really are listed: a file that turns out to be listed already doesn't use a slot.
      for (const file of picked) {
        if (next.length >= ATTACHMENT_MAX_FILES) { skipped++; continue; }
        try {
          const r = await uploadCampaignAttachment(t, file);
          if (!next.some((f) => f.path === r.attachment_path)) {
            next.push({ path: r.attachment_path, name: r.attachment_name, mime: r.attachment_mime, size: r.attachment_size });
          }
        } catch (e) {
          toast.error(`${file.name}: ${(e as Error).message}`);
        }
      }
      if (skipped) toast.error(`Up to ${ATTACHMENT_MAX_FILES} files per campaign; ${skipped} skipped`);
      if (next.length !== files.length) await save(next, `${next.length - files.length} file${next.length - files.length === 1 ? "" : "s"} added`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(path: string) {
    if (!files) return;
    setBusy(true);
    try {
      await save(files.filter((f) => f.path !== path), "File removed");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const count = files?.length ?? 0;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Paperclip className="size-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-[13px] font-medium leading-none">Attachments</p>
            <p className="text-xs text-muted-foreground mt-1">
              Saved as soon as you add or remove a file. Sent as download links at the end of the first email. 25 MB each.
              Use clear file names: the AI reads them.
            </p>
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-label="Files used">
          {files === null ? "–" : count} / {ATTACHMENT_MAX_FILES} files
        </span>
      </div>

      {files === null ? (
        <div className="h-10 rounded-lg bg-secondary animate-pulse" />
      ) : (
        <>
          {files.length === 0 && <p className="text-xs text-muted-foreground">No files. The emails will not mention an attachment.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {files.map((f) => (
              <div key={f.path} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary px-2.5 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0 tabular-nums">({formatBytes(f.size)})</span>
                </div>
                {!readOnly && (
                  <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={() => void remove(f.path)}
                          aria-label={`Remove ${f.name}`} className="text-muted-foreground hover:text-foreground">
                    <X />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {!readOnly && count < ATTACHMENT_MAX_FILES && (
            <>
              {/* eslint-disable-next-line no-restricted-syntax -- hidden file picker; the visible control is the Button beside it */}
              <input ref={inputRef} type="file" className="hidden" multiple
                     accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                     onChange={(e) => void add(e.target.files)} />
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {busy ? "Saving…" : count ? "Add more files" : "Add files"}
              </Button>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Changes update unsent first emails at once. Emails already sent keep their links.
          </p>
        </>
      )}
    </div>
  );
}
