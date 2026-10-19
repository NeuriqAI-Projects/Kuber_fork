"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { sendUniboxReply } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { ReplyAttachButton, ReplyAttachmentChips } from "@/components/app/reply-attach-controls";
import { ReplyCcBccFields, normalizeReplyEmails, validateCcBcc } from "@/components/app/reply-cc-bcc-fields";
import { ComposerRow, LeadExcludedWarning, ReplyToField } from "@/components/app/reply-recipients";
import { appendReplyAttachments, type ReplyAttachment } from "@/lib/reply-attachments";

/**
 * Who the reply goes to, when the caller knows the thread's participants.
 * Optional: a caller that omits it keeps the previous behaviour (no To field,
 * empty CC, answer the newest inbound message).
 */
export type ReplyRecipientContext = {
  /** Initial To list. "Reply" seeds just the sender; "Reply all" seeds everyone. */
  to: string[];
  /** Address Instantly forces into To — rendered locked, cannot be removed. */
  lockedTo: string | null;
  /** Everyone else on the thread, offered as one-click additions. */
  participants: string[];
  leadEmail: string | null;
  leadName: string;
  /** Message being answered. null = server picks the newest inbound one. */
  replyToUuid: string | null;
};

/**
 * Plain human-written reply — no AI, no reply_drafts row. Shared by Unibox and
 * campaign Outbox so both surfaces can answer a thread without an AI draft
 * existing first, which is the normal state now that drafting is opt-in.
 */
export function ManualReplyBox({
  threadId,
  token,
  replyToSubject,
  onSent,
  onCancel,
  onNewAiDraft,
  newAiDraftPending = false,
  recipients,
}: {
  threadId: string;
  token: string;
  replyToSubject: string | null;
  onSent: () => void;
  onCancel: () => void;
  recipients?: ReplyRecipientContext;
  /** Hands the reply over to the AI instead. This is the only place the first
   *  draft of a thread can be started from, since with no draft row there is no
   *  ReplyDraftBox header to carry the button. Omit to hide it. */
  onNewAiDraft?: () => void;
  newAiDraftPending?: boolean;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setSubject(replyToSubject ? `Re: ${replyToSubject.replace(/^Re:\s*/i, "")}` : "");
    setBody("");
    setTo(recipients?.to ?? []);
    setCc([]);
    setBcc([]);
    setAttachments([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recipients seed only, not an edit trigger
  }, [threadId, replyToSubject]);

  // Re-seed To when the target or the Reply/Reply-all choice changes. Kept out
  // of the effect above so re-aiming a reply never wipes a half-written body.
  const toKey = (recipients?.to ?? []).join(",");
  useEffect(() => {
    if (!recipients) return;
    setTo(recipients.to);
    setCc([]);
    setBcc([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toKey stands in for the array identity
  }, [recipients?.replyToUuid, toKey]);

  const bodyText = body.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
  // Subject is deliberately NOT required. This is a reply: it threads on
  // reply_to_uuid, and the server fills a missing subject from the thread. It
  // used to be part of this condition, which meant a thread with no subject to
  // seed from left the button greyed out with nothing on screen explaining why
  // — reported from production on 26 Aug 2026 as "cannot send the reply".
  const canSend = bodyText.length > 0 || attachments.length > 0;

  async function handleSend() {
    if (!canSend) return;
    const ccN = normalizeReplyEmails(cc);
    const bccN = normalizeReplyEmails(bcc);
    const listErr = validateCcBcc(ccN, bccN);
    if (listErr) {
      toast.error(listErr);
      return;
    }
    setSending(true);
    try {
      const bodyHtml = appendReplyAttachments(body.replace(/\n/g, "<br>"), attachments);
      await sendUniboxReply(token, {
        thread_id: threadId,
        subject,
        body_html: bodyHtml,
        body_text: [bodyText, ...attachments.map((a) => a.name)].filter(Boolean).join("\n"),
        ...(to.length ? { to: normalizeReplyEmails(to) } : {}),
        ...(ccN.length ? { cc: ccN } : {}),
        ...(bccN.length ? { bcc: bccN } : {}),
        ...(recipients?.replyToUuid ? { reply_to_uuid: recipients.replyToUuid } : {}),
      });
      toast.success("Reply sent");
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <p className="text-[13px] font-medium text-foreground">Reply</p>
        <div className="ml-auto flex items-center gap-1">
          {onNewAiDraft && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={newAiDraftPending}
              onClick={onNewAiDraft}
              className="px-2 text-primary hover:text-primary"
              title="Write this reply with AI"
            >
              {newAiDraftPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {newAiDraftPending ? "Generating…" : "AI draft"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="px-2 text-muted-foreground"
          >
            Cancel
          </Button>
        </div>
      </div>
      <div className="space-y-2 p-3">
        {recipients && (
          <>
            <ReplyToField
              to={to}
              onChange={setTo}
              lockedTo={recipients.lockedTo}
              suggestions={recipients.participants}
              disabled={sending}
            />
            <LeadExcludedWarning
              to={to}
              cc={cc}
              bcc={bcc}
              leadEmail={recipients.leadEmail}
              leadName={recipients.leadName}
            />
          </>
        )}
        <ReplyCcBccFields
          token={token}
          cc={cc}
          bcc={bcc}
          onCcChange={setCc}
          onBccChange={setBcc}
          disabled={sending}
        />
        <ComposerRow label="Subject" htmlFor={`manual-reply-subject-${threadId}`}>
          <Input id={`manual-reply-subject-${threadId}`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </ComposerRow>
        <RichTextEditor value={body} onChange={setBody} placeholder="Write your reply…" minHeight={120} />
        <ReplyAttachmentChips
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
        />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <ReplyAttachButton
          token={token}
          disabled={sending}
          currentCount={attachments.length}
          onUploaded={(a) => setAttachments((prev) => [...prev, a])}
        />
        <Button disabled={sending || !canSend} onClick={() => void handleSend()} className="ml-auto">
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send reply
        </Button>
      </div>
    </div>
  );
}
