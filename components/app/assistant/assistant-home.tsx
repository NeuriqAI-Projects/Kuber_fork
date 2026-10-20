"use client";

// Home tab: a greeting, "Ask Kuber AI", the last conversation, today's numbers
// (each one a question away), and suggested questions.
import { ArrowRight, Brain, ChevronRight, Flame, Inbox, MailOpen, PenLine, Zap } from "lucide-react";
import { KuberAiMark } from "@/components/app/assistant/kuber-ai-mark";
import { SizeControls, shortWhen, type PanelHost } from "@/components/app/assistant/assistant-chrome";
import type { AssistantOverview, AssistantThreadSummary } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export type Suggestion = { text: string; deep?: boolean };

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function AssistantHome({
  host, firstName, overview, recent, suggestions, onAsk, onNewChat, onOpenThread,
}: {
  host: PanelHost;
  firstName: string | null;
  overview: AssistantOverview | null;
  recent: AssistantThreadSummary | null;
  suggestions: Suggestion[];
  onAsk: (text: string, deep?: boolean) => void;
  onNewChat: () => void;
  onOpenThread: (id: string) => void;
}) {
  const tiles = overview
    ? [
      { label: "Replies waiting", value: overview.to_do.replies_needing_answer, Icon: Inbox, ask: "Which replies still need an answer from us?", alert: overview.to_do.replies_needing_answer > 0 },
      { label: "Drafts to review", value: overview.to_do.drafts_waiting_review, Icon: PenLine, ask: "Which campaigns have email drafts waiting for review?" },
      { label: "Hot leads", value: overview.in_campaigns.hot, Icon: Flame, ask: "Show me our hot leads and where each one stands." },
      { label: "Unread emails", value: overview.to_do.unread_emails, Icon: MailOpen, ask: "Summarise the unread emails in the inbox." },
    ]
    : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background">
      <div className="kuber-ai-hero relative px-4 pb-12 pt-3 text-white">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-start justify-between">
            <KuberAiMark className="mt-1 size-9 shadow-lg shadow-black/20 rounded-[10px]" />
            <div className="-mr-1.5">
              <SizeControls host={host} onBrand />
            </div>
          </div>
          <p className="mt-3 text-[13px] text-white/75">{greeting()}{firstName ? `, ${firstName}` : ""}</p>
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">How can I help today?</h2>
        </div>
      </div>

      {/* relative z-10: the cards overlap the hero and must paint above it. */}
      <div className="relative z-10 mx-auto -mt-8 flex w-full max-w-2xl flex-col gap-2.5 px-3 pb-4">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-3 rounded-xl border border-border bg-popover p-3.5 text-left shadow-lg transition-colors hover:border-primary/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">Ask Kuber AI</span>
            <span className="block text-[12px] text-muted-foreground">Leads, campaigns, replies and team — from your live data</span>
          </span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowRight className="size-4" />
          </span>
        </button>

        {recent && (
          <button
            type="button"
            onClick={() => onOpenThread(recent.id)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-primary/40"
          >
            <KuberAiMark className="size-7" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{recent.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{shortWhen(recent.updated_at)}</span>
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {recent.preview ? `${recent.last_role === "user" ? "You" : "Kuber AI"}: ${recent.preview}` : "Continue this conversation"}
              </span>
            </span>
          </button>
        )}

        <section className="rounded-xl border border-border bg-card">
          <header className="flex items-center justify-between px-3.5 pb-1 pt-3">
            <p className="text-[12.5px] font-semibold">At a glance</p>
            <p className="text-[11px] text-muted-foreground">{overview?.scope === "your assigned leads only" ? "Your leads" : "Whole team"}</p>
          </header>
          <div className="grid grid-cols-2 gap-2 p-2.5">
            {(tiles ?? Array.from({ length: 4 }, () => null)).map((t, i) =>
              t ? (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => onAsk(t.ask)}
                  className="group flex flex-col items-start gap-1 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-hover"
                >
                  <span className="flex w-full items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <t.Icon className="size-3.5" />
                    <span className="flex-1 truncate">{t.label}</span>
                    <ChevronRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                  </span>
                  <span className={cn("text-[20px] font-semibold tabular-nums leading-none", t.alert && "text-amber-600 dark:text-amber-400")}>
                    {t.value.toLocaleString()}
                  </span>
                </button>
              ) : (
                <div key={i} className="h-[62px] rounded-lg border border-border bg-secondary" />
              ),
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <p className="px-3.5 pb-1 pt-3 text-[12.5px] font-semibold">Try asking</p>
          <ul className="divide-y divide-border">
            {suggestions.map((s) => (
              <li key={s.text}>
                <button
                  type="button"
                  onClick={() => onAsk(s.text, s.deep)}
                  className="group flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover"
                >
                  {s.deep ? <Brain className="size-3.5 shrink-0 text-muted-foreground" /> : <Zap className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 text-[13px]">{s.text}</span>
                  {s.deep && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Deep</span>}
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
