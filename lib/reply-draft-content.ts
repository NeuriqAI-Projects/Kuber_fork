import type { ReplyDraft } from "@/lib/api-client";

/** True when the draft has real subject/body text (ignores empty HTML shells).
 *  Lives outside reply-draft-box.tsx so screens can call it without pulling
 *  the tiptap editor into their first bundle. */
export function replyDraftHasContent(draft: Pick<ReplyDraft, "subject" | "body"> | null | undefined): boolean {
  if (!draft) return false;
  if (draft.subject?.trim()) return true;
  const text = (draft.body ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
  return text.length > 0;
}
