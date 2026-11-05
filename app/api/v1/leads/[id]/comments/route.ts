import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/auth/api-auth";
import { assertLeadAccess } from "@/lib/auth/scope";
import { ok, fail } from "@/lib/api-response";
import {
  loadCommentReactionGroups,
} from "@/lib/comment-reactions";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

type CommentRow = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
};

async function serializeComments(
  db: SupabaseClient,
  rows: CommentRow[],
  currentUserId: string,
) {
  const authorIds = [...new Set(rows.map((row) => row.author_id))];
  const authorNames = new Map<string, string>();

  if (authorIds.length > 0) {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, full_name, email")
      .in("id", authorIds);

    for (const profile of profiles ?? []) {
      authorNames.set(
        profile.id as string,
        (profile.full_name || profile.email || "Team member") as string,
      );
    }
  }

  const reactionsByComment = await loadCommentReactionGroups(
    db,
    "lead_comment_reactions",
    rows.map((row) => row.id),
    currentUserId,
  );

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    author_id: row.author_id,
    author_name: authorNames.get(row.author_id) ?? "Team member",
    created_at: row.created_at,
    reactions: reactionsByComment.get(row.id) ?? [],
  }));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (response) { return response as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertLeadAccess(db, user, id); } catch (response) { return response as Response; }

  const { data, error } = await db
    .from("lead_comments")
    .select("id, author_id, body, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ comments: await serializeComments(db, (data ?? []) as CommentRow[], user.id) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (response) { return response as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertLeadAccess(db, user, id); } catch (response) { return response as Response; }

  let payload: unknown;
  try { payload = await req.json(); } catch { return fail(400, "VALIDATION_ERROR", "Invalid JSON body"); }

  const body = typeof payload === "object" && payload !== null && "body" in payload
    ? String((payload as { body: unknown }).body).trim()
    : "";

  if (!body) return fail(400, "VALIDATION_ERROR", "Message cannot be empty");
  if (body.length > 2000) return fail(400, "VALIDATION_ERROR", "Message must be 2,000 characters or fewer");

  const { data, error } = await db
    .from("lead_comments")
    .insert({ lead_id: id, author_id: user.id, body })
    .select("id, author_id, body, created_at")
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  const [comment] = await serializeComments(db, [data as CommentRow], user.id);
  return ok({ comment });
}
