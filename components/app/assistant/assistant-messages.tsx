"use client";

// Messages tab, list view: the user's saved conversations and "New conversation".
import { Loader2, MessageSquarePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KuberAiMark } from "@/components/app/assistant/kuber-ai-mark";
import { TopBar, shortWhen, type PanelHost } from "@/components/app/assistant/assistant-chrome";
import type { AssistantThreadSummary } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export function AssistantMessagesList({
  host, threads, available, activeId, onOpen, onDelete, onNew,
}: {
  host: PanelHost;
  /** null while loading. */
  threads: AssistantThreadSummary[] | null;
  available: boolean;
  activeId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      <TopBar title="Messages" subtitle="Your conversations with Kuber AI" host={host} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-2xl">
          {!available ? (
            <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              Saved conversations turn on once the 19 Oct assistant database update has been run.
            </p>
          ) : threads === null ? (
            <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
          ) : threads.length === 0 ? (
            <div className="flex flex-col items-center px-8 pt-16 text-center">
              <KuberAiMark className="size-12" />
              <p className="mt-4 text-[15px] font-semibold">No conversations yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">Ask about your leads, campaigns or replies — your chats are saved here.</p>
            </div>
          ) : (
            <ul aria-label="Your conversations" className="divide-y divide-border">
              {threads.map((t) => (
                <li key={t.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpen(t.id)}
                    className={cn("flex w-full items-start gap-3 px-4 py-3 pr-12 text-left transition-colors hover:bg-hover", t.id === activeId && "bg-accent")}
                  >
                    <KuberAiMark className="mt-0.5 size-8" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{t.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{shortWhen(t.updated_at)}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
                        {t.preview ? `${t.last_role === "user" ? "You" : "Kuber AI"}: ${t.preview}` : `${t.message_count} messages`}
                      </span>
                    </span>
                  </button>
                  <Button
                    variant="ghost" size="icon-sm"
                    className="absolute right-2 top-3 text-muted-foreground opacity-100 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                    aria-label={`Delete “${t.title}”`} title="Delete conversation"
                    onClick={() => onDelete(t.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="px-6 py-4 text-center text-[11px] text-muted-foreground">Only you can see your conversations.</p>
        </div>
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <Button className="mx-auto flex h-9 w-full max-w-2xl" onClick={onNew}>
          <MessageSquarePlus /> New conversation
        </Button>
      </div>
    </>
  );
}
