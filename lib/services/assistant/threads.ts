// Saved assistant chats (table assistant_threads, migration 2026_10_19_assistant.sql).
//
// One row per chat holding the whole UI message list as JSON — the chat is
// always loaded and saved as a unit, so a per-message table would only add
// joins. Every function here is best-effort until the migration is run: a
// missing table means "history is off", never "the assistant is broken".
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";

export type ThreadSummary = {
  id: string; title: string; updated_at: string; message_count: number;
  /** The newest message as one line of plain text, for the conversation list. */
  preview: string | null;
  last_role: "user" | "assistant" | null;
};

/** One line of plain text from a message: its text parts, markdown stripped. */
export function messagePreview(m: { parts?: Array<{ type?: string; text?: string }> } | null | undefined): string | null {
  const text = (m?.parts ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
  const clean = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 120) : null;
}

const MAX_SAVED_MESSAGES = 200;

export async function listThreads(db: SupabaseClient, userId: string, limit = 40): Promise<ThreadSummary[] | null> {
  // `messages->-1` = only the newest message, not the whole chat.
  const { data, error } = await db
    .from("assistant_threads")
    .select("id, title, updated_at, message_count, last:messages->-1")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) return null;
  type Row = { id: string; title: string; updated_at: string; message_count: number; last?: { role?: string; parts?: Array<{ type?: string; text?: string }> } | null };
  return ((data ?? []) as unknown as Row[]).map((row) => {
    const last = row.last ?? null;
    return {
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      message_count: row.message_count,
      preview: messagePreview(last),
      last_role: last?.role === "user" || last?.role === "assistant" ? last.role : null,
    };
  });
}

export async function loadThread(db: SupabaseClient, userId: string, id: string): Promise<{ id: string; title: string; messages: UIMessage[] } | null> {
  const { data, error } = await db
    .from("assistant_threads")
    .select("id, title, messages")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, title: data.title as string, messages: (data.messages ?? []) as UIMessage[] };
}

export function fallbackTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Insert or replace a chat. Returns false when history storage is unavailable. */
export async function saveThread(
  db: SupabaseClient,
  userId: string,
  id: string,
  messages: UIMessage[],
  title?: string,
): Promise<boolean> {
  const trimmed = messages.slice(-MAX_SAVED_MESSAGES);
  const now = new Date().toISOString();
  const { data: existing, error: readErr } = await db
    .from("assistant_threads").select("id, user_id").eq("id", id).maybeSingle();
  if (readErr) return false;
  if (existing && existing.user_id !== userId) return false;
  if (existing) {
    const { error } = await db.from("assistant_threads")
      .update({ messages: trimmed, message_count: trimmed.length, updated_at: now, ...(title ? { title } : {}) })
      .eq("id", id);
    return !error;
  }
  const { error } = await db.from("assistant_threads").insert({
    id, user_id: userId, title: title ?? fallbackTitle(trimmed), messages: trimmed, message_count: trimmed.length,
    created_at: now, updated_at: now,
  });
  return !error;
}

export async function renameThread(db: SupabaseClient, userId: string, id: string, title: string): Promise<void> {
  await db.from("assistant_threads").update({ title }).eq("id", id).eq("user_id", userId);
}

export async function deleteThread(db: SupabaseClient, userId: string, id: string): Promise<boolean> {
  const { error } = await db.from("assistant_threads").delete().eq("id", id).eq("user_id", userId);
  return !error;
}
