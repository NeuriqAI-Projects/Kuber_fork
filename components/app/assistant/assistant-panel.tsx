"use client";

// Kuber AI — the assistant side panel, available on every signed-in screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, Brain, Loader2, MessageSquarePlus, RotateCcw, Square, Zap } from "lucide-react";
import { TabBar, TopBar, type AssistantTab, type PanelHost } from "@/components/app/assistant/assistant-chrome";
import { AssistantHome } from "@/components/app/assistant/assistant-home";
import { AssistantMessagesList } from "@/components/app/assistant/assistant-messages";
import { AssistantSkills, type Skill } from "@/components/app/assistant/assistant-skills";
import { KuberAiMark } from "@/components/app/assistant/kuber-ai-mark";
import { assistantPanelClass, type AssistantSize } from "@/components/app/assistant/assistant-launcher";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { AssistantMarkdown } from "@/components/app/assistant/assistant-markdown";
import {
  ActionCard, isActionTool, toolNameOf, ToolSteps, type ActionOutcome, type ToolPartLike,
} from "@/components/app/assistant/assistant-parts";
import { useApp } from "@/lib/app-context";
import {
  deleteAssistantThread, executeAssistantAction, fetchAssistantOverview, fetchAssistantThread, fetchAssistantThreads, saveAssistantThread,
  type AssistantOverview, type AssistantThreadSummary,
} from "@/lib/api-client";
import type { AssistantUIMessage } from "@/lib/services/assistant/agent";
import { cn } from "@/lib/utils";

type Mode = "fast" | "deep";
const MODE_KEY = "kuber.assistant.mode";

const SUGGESTIONS: Record<"manager" | "employee", Array<{ text: string; deep?: boolean }>> = {
  manager: [
    { text: "What should the team focus on today?" },
    { text: "Which enriched leads are not in any campaign yet?" },
    { text: "Who replied this week and still needs an answer?" },
    { text: "How are our active campaigns doing?" },
    { text: "Why are some campaigns getting more replies than others?", deep: true },
  ],
  employee: [
    { text: "What should I focus on today?" },
    { text: "Which of my leads are ready for a campaign?" },
    { text: "Who replied to me and still needs an answer?" },
    { text: "How are my campaigns doing?" },
  ],
};

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function AssistantPanel({
  onClose, size, onSize, phone, hidden,
}: {
  onClose: () => void;
  size: AssistantSize;
  onSize: (s: AssistantSize) => void;
  phone: boolean;
  /** Closed but kept mounted, so the conversation survives closing and reopening. */
  hidden?: boolean;
}) {
  const { session, role, loadCampaigns } = useApp();
  const tokenRef = useRef<string>("");
  tokenRef.current = session?.access_token ?? "";

  const [mode, setMode] = useState<Mode>("fast");
  const modeRef = useRef<Mode>("fast");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "deep" || saved === "fast") { setMode(saved); modeRef.current = saved; }
    } catch { /* storage blocked — default stays */ }
  }, []);
  const changeMode = (m: Mode) => {
    setMode(m);
    modeRef.current = m;
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };

  // One chat id per conversation; it doubles as the saved thread's id.
  const [chat, setChat] = useState<{ id: string; initial: AssistantUIMessage[] }>(() => ({ id: newId(), initial: [] }));
  const chatIdRef = useRef(chat.id);
  chatIdRef.current = chat.id;

  const transport = useMemo(() => new DefaultChatTransport<AssistantUIMessage>({
    api: "/api/v1/assistant/chat",
    headers: () => ({ Authorization: `Bearer ${tokenRef.current}` }),
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { messages, mode: modeRef.current, thread_id: chatIdRef.current },
    }),
  }), []);

  const { messages, setMessages, sendMessage, status, stop, error, regenerate, clearError } = useChat<AssistantUIMessage>({
    id: chat.id,
    messages: chat.initial,
    transport,
  });

  const busy = status === "submitted" || status === "streaming";
  const [input, setInput] = useState("");
  // Where the user is: a tab, or inside one conversation (which hides the tab bar, like Chatty).
  const [tab, setTab] = useState<AssistantTab>("home");
  const [inThread, setInThread] = useState(false);
  const [threads, setThreads] = useState<AssistantThreadSummary[] | null>(null);
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [overview, setOverview] = useState<AssistantOverview | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const host: PanelHost = { size, phone, onSize, onClose };

  // Follow the answer as it streams, unless the user scrolled up to read.
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => { if (inThread) inputRef.current?.focus(); }, [chat.id, inThread]);

  const loadThreads = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const r = await fetchAssistantThreads(tokenRef.current);
      setHistoryAvailable(r.available);
      setThreads(r.threads);
    } catch {
      setThreads((prev) => prev ?? []);
    }
  }, []);

  const loadOverview = useCallback(async () => {
    if (!tokenRef.current) return;
    try { setOverview(await fetchAssistantOverview(tokenRef.current)); } catch { /* the tiles stay as placeholders */ }
  }, []);

  // Home needs the latest chat and today's numbers; refresh them whenever it is shown.
  useEffect(() => {
    if (hidden || inThread) return;
    void loadThreads();
    if (tab === "home") void loadOverview();
  }, [tab, inThread, hidden, loadThreads, loadOverview]);

  // A finished answer may have renamed the chat (titles are written just after) — refresh the list.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const t = setTimeout(() => void loadThreads(), 2500);
      wasBusy.current = false;
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
  }, [busy, loadThreads]);

  const send = useCallback((text: string, forceMode?: Mode) => {
    const t = text.trim();
    if (!t || busy) return;
    if (forceMode && forceMode !== modeRef.current) changeMode(forceMode);
    if (error) clearError();
    stickToBottom.current = true;
    void sendMessage({ text: t });
    setInput("");
  }, [busy, error, clearError, sendMessage]);

  /** A fresh conversation, optionally with a sentence in the box for the user to finish. */
  const startNew = useCallback((prefill = "") => {
    if (busy) stop();
    setChat({ id: newId(), initial: [] });
    setTab("messages");
    setInThread(true);
    setInput(prefill);
  }, [busy, stop]);

  // Asking from Home or Skills starts a new chat; the question is sent once that chat exists.
  const pendingAsk = useRef<{ text: string; mode?: Mode } | null>(null);
  const ask = useCallback((text: string, deep?: boolean) => {
    const mode = deep ? "deep" : undefined;
    if (inThread && messages.length === 0) { send(text, mode); return; }
    pendingAsk.current = { text, mode };
    startNew();
  }, [inThread, messages.length, send, startNew]);
  useEffect(() => {
    const p = pendingAsk.current;
    if (!p) return;
    pendingAsk.current = null;
    send(p.text, p.mode);
  }, [chat.id, send]);

  const openThread = async (id: string) => {
    try {
      const t = await fetchAssistantThread<AssistantUIMessage>(tokenRef.current, id);
      // Same id as the open chat: the hook keeps its chat instance, so load the messages into it directly.
      if (t.id === chat.id) setMessages(t.messages);
      else setChat({ id: t.id, initial: t.messages });
      setTab("messages");
      setInThread(true);
    } catch { /* stays on the list */ }
  };

  const removeThread = async (id: string) => {
    await deleteAssistantThread(tokenRef.current, id).catch(() => {});
    setThreads((prev) => prev?.filter((t) => t.id !== id) ?? null);
    if (id === chat.id) setChat({ id: newId(), initial: [] });
  };

  const pickSkill = (s: Skill) => {
    if (s.ask) { ask(s.ask, s.deep); return; }
    if (s.deep) changeMode("deep");
    startNew(s.template ?? "");
    // Put the cursor at the first blank ('' or a double space), else at the end.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      const text = s.template ?? "";
      if (!el) return;
      const quote = text.indexOf("''");
      const gap = text.indexOf("  ");
      const at = quote >= 0 ? quote + 1 : gap >= 0 ? gap + 1 : text.length;
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  /** Write an action's outcome into its tool part so the card shows it, the model sees it next turn, and history keeps it. */
  const settleAction = useCallback((toolCallId: string, patch: { executed?: ActionOutcome; cancelled?: boolean }) => {
    setMessages((prev) => {
      const next = prev.map((m) => ({
        ...m,
        parts: m.parts.map((p) => {
          const tp = p as unknown as ToolPartLike;
          if (tp.toolCallId !== toolCallId || tp.state !== "output-available") return p;
          return { ...p, output: { ...(tp.output as object), ...patch } } as typeof p;
        }),
      }));
      void saveAssistantThread(tokenRef.current, chatIdRef.current, next).catch(() => {});
      return next;
    });
  }, [setMessages]);

  const confirmAction = useCallback(async (toolCallId: string, proposalToken: string, kind: string) => {
    let outcome: ActionOutcome;
    try {
      outcome = await executeAssistantAction(tokenRef.current, proposalToken);
    } catch (e) {
      outcome = { ok: false, message: (e as Error).message || "The action failed." };
    }
    settleAction(toolCallId, { executed: outcome });
    if (outcome.ok && (kind === "create_campaign" || kind === "add_to_campaign" || kind.endsWith("_campaign"))) {
      void loadCampaigns(tokenRef.current);
    }
  }, [settleAction, loadCampaigns]);

  const suggestions = SUGGESTIONS[role === "employee" ? "employee" : "manager"];
  const firstName = (() => {
    const local = session?.user.email?.split("@")[0]?.split(/[._\d-]/)[0];
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : null;
  })();
  const firstQuestion = messages.find((m) => m.role === "user")?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
  const threadTitle = threads?.find((t) => t.id === chat.id)?.title
    ?? (firstQuestion ? (firstQuestion.length > 48 ? `${firstQuestion.slice(0, 45)}…` : firstQuestion) : "New conversation");

  return (
    <aside
      role={size === "full" || phone ? "dialog" : "complementary"}
      aria-label="Kuber AI"
      className={cn("flex flex-col overflow-hidden bg-background", assistantPanelClass(size, phone), hidden && "hidden")}
    >
      {!inThread && tab === "home" && (
        <AssistantHome
          host={host}
          firstName={firstName}
          overview={overview}
          recent={threads?.[0] ?? null}
          suggestions={suggestions}
          onAsk={ask}
          onNewChat={() => startNew()}
          onOpenThread={(id) => void openThread(id)}
        />
      )}
      {!inThread && tab === "messages" && (
        <AssistantMessagesList
          host={host}
          threads={threads}
          available={historyAvailable}
          activeId={chat.id}
          onOpen={(id) => void openThread(id)}
          onDelete={(id) => void removeThread(id)}
          onNew={() => startNew()}
        />
      )}
      {!inThread && tab === "skills" && <AssistantSkills host={host} role={role} onPick={pickSkill} />}

      {inThread && (
        <>
          <TopBar
            host={host}
            onBack={() => { setInThread(false); void loadThreads(); }}
            icon={(
              <span className="relative">
                <KuberAiMark className="size-7" />
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500" aria-hidden />
              </span>
            )}
            title={threadTitle}
            subtitle={busy ? (mode === "deep" ? "Thinking it through…" : "Looking it up…") : mode === "deep" ? "Deep analysis" : "Kuber AI · live data"}
            actions={(
              <Button variant="ghost" size="icon-sm" title="New conversation" aria-label="New conversation" onClick={() => startNew()}>
                <MessageSquarePlus className="size-4" />
              </Button>
            )}
          />

          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 ? (
              <div className={cn("mx-auto flex h-full w-full max-w-2xl flex-col pb-2", size === "full" && !phone ? "justify-center" : "justify-end")}>
                <div className="mb-4">
                  <KuberAiMark className="size-10" />
                  <p className="mt-3 text-[16px] font-semibold">What do you want to know?</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Answers come from your live data. It can also set things up for you — nothing changes until you confirm.
                  </p>
                </div>
                <div className="space-y-1.5">
                  {suggestions.slice(0, 3).map((s) => (
                    <button
                      key={s.text}
                      type="button"
                      onClick={() => send(s.text, s.deep ? "deep" : undefined)}
                      className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-[13px] hover:bg-hover transition-colors"
                    >
                      {s.deep ? <Brain className="size-3.5 shrink-0 text-muted-foreground" /> : <Zap className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="flex-1">{s.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-2xl space-y-5">
                {messages.map((m, i) => (
                  <MessageView
                    key={m.id || `m${i}`}
                    message={m}
                    isLast={i === messages.length - 1}
                    streaming={busy && i === messages.length - 1}
                    showCost={role === "manager"}
                    onConfirm={(toolCallId, token, kind) => confirmAction(toolCallId, token, kind)}
                    onCancel={(toolCallId) => settleAction(toolCallId, { cancelled: true })}
                  />
                ))}
                {status === "submitted" && messages[messages.length - 1]?.role === "user" && (
                  <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {mode === "deep" ? "Thinking it through…" : "Looking it up…"}
                  </div>
                )}
                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                    <span className="flex-1">{friendlyError(error)}</span>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => { clearError(); void regenerate(); }}>
                      <RotateCcw className="size-3" /> Retry
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-border p-3">
            <div className="mx-auto w-full max-w-2xl">
              <div className="mb-2 flex items-center justify-between">
                <SegmentedTabs<Mode>
                  size="sm"
                  value={mode}
                  onValueChange={changeMode}
                  options={[
                    { value: "fast", label: "Fast", icon: Zap },
                    { value: "deep", label: "Deep analysis", icon: Brain },
                  ]}
                />
                <span className="text-[11.5px] text-muted-foreground">{mode === "deep" ? "Slower, thorough" : "Quick answers"}</span>
              </div>
              <div className="relative">
                <Textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder="Ask about leads, campaigns, replies…"
                  rows={2}
                  className="min-h-[64px] resize-none pr-11 text-[13.5px]"
                />
                {busy ? (
                  <Button size="icon-sm" variant="outline" className="absolute bottom-2 right-2" title="Stop" aria-label="Stop" onClick={() => stop()}>
                    <Square className="size-3 fill-current" />
                  </Button>
                ) : (
                  <Button size="icon-sm" className="absolute bottom-2 right-2" title="Send (Enter)" aria-label="Send" disabled={!input.trim()} onClick={() => send(input)}>
                    <ArrowUp className="size-4" />
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">Actions always ask before changing anything.</p>
            </div>
          </div>
        </>
      )}

      {!inThread && <TabBar tab={tab} onTab={setTab} />}
    </aside>
  );
}

function friendlyError(error: Error): string {
  const msg = error.message || "";
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch { /* plain text */ }
  return msg && msg.length < 200 ? msg : "Something went wrong. Please try again.";
}

function MessageView({
  message, isLast, streaming, showCost, onConfirm, onCancel,
}: {
  message: AssistantUIMessage;
  isLast: boolean;
  streaming: boolean;
  showCost: boolean;
  onConfirm: (toolCallId: string, token: string, kind: string) => Promise<void>;
  onCancel: (toolCallId: string) => void;
}) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-[13.5px]">{text}</div>
      </div>
    );
  }

  // Group consecutive lookups into one step list; text and action cards render in order between them.
  type Chunk = { kind: "text"; text: string; key: string } | { kind: "steps"; parts: ToolPartLike[]; key: string } | { kind: "action"; part: ToolPartLike; key: string };
  const chunks: Chunk[] = [];
  message.parts.forEach((p, i) => {
    if (p.type === "text") {
      if (p.text.trim()) chunks.push({ kind: "text", text: p.text, key: `t${i}` });
      return;
    }
    if (!p.type.startsWith("tool-")) return;
    const tp = p as unknown as ToolPartLike;
    if (isActionTool(toolNameOf(tp))) { chunks.push({ kind: "action", part: tp, key: tp.toolCallId }); return; }
    const last = chunks[chunks.length - 1];
    if (last?.kind === "steps") last.parts.push(tp);
    else chunks.push({ kind: "steps", parts: [tp], key: `s${i}` });
  });

  const meta = message.metadata;
  return (
    <div className="space-y-2.5">
      {chunks.map((c) => {
        if (c.kind === "text") return <AssistantMarkdown key={c.key} text={c.text} />;
        if (c.kind === "steps") return <ToolSteps key={c.key} parts={c.parts} />;
        const out = c.part.output as { proposal?: { token: string; kind: string } } | undefined;
        return (
          <ActionCard
            key={c.key}
            part={c.part}
            disabled={streaming}
            onConfirm={async () => { if (out?.proposal) await onConfirm(c.part.toolCallId, out.proposal.token, out.proposal.kind); }}
            onCancel={() => onCancel(c.part.toolCallId)}
          />
        );
      })}
      {!streaming && meta?.durationMs != null && (
        <p className={cn("text-[11px] text-muted-foreground/80 tabular-nums", !isLast && "opacity-0 hover:opacity-100 transition-opacity")}>
          {meta.mode === "deep" ? "Deep" : "Fast"} · {meta.model ?? "AI"} · {(meta.durationMs / 1000).toFixed(1)}s
          {showCost && typeof meta.costUsd === "number" ? ` · $${meta.costUsd < 0.01 ? meta.costUsd.toFixed(4) : meta.costUsd.toFixed(3)}` : ""}
        </p>
      )}
    </div>
  );
}
