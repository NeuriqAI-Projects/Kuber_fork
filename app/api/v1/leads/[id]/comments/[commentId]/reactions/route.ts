import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { assertLeadAccess } from "@/lib/auth/scope";
import { ok, fail } from "@/lib/api-response";
import {
  isCommentReactionEmoji,
  loadCommentReactionGroups,
  type CommentReactionGroup,
} from "@/lib/comment-reactions";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

/** Toggle a reaction on a lead comment. Body: `{ emoji: "👍" }`. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (response) { return response as Response; }

  const { id, commentId } = await params;
  const db = dbForUser(user);
  try { await assertLeadAccess(db, user, id); } catch (response) { return response as Response; }

  let payload: unknown;
  try { payload = await req.json(); } catch { return fail(400, "VALIDATION_ERROR", "Invalid JSON body"); }

  const emoji = typeof payload === "object" && payload !== null && "emoji" in payload
    ? (payload as { emoji: unknown }).emoji
    : null;

  if (!isCommentReactionEmoji(emoji)) {
    return fail(400, "VALIDATION_ERROR", "Unsupported reaction emoji");
  }

  const { data: comment, error: commentError } = await db
    .from("lead_comments")
    .select("id")
    .eq("id", commentId)
    .eq("lead_id", id)
    .maybeSingle();

  if (commentError) return fail(500, "INTERNAL", commentError.message);
  if (!comment) return fail(404, "NOT_FOUND", "Comment not found");

  const { data: existing } = await db
    .from("lead_comment_reactions")
    .select("id")
    .eq("comment_id", commentId)
    .eq("user_id", user.id)
    .eq("emoji", emoji)
    .maybeSingle();

  if (existing) {
    const { error: deleteError } = await db
      .from("lead_comment_reactions")
      .delete()
      .eq("id", existing.id);
    if (deleteError) return fail(500, "INTERNAL", deleteError.message);
  } else {
    const { error: insertError } = await db
      .from("lead_comment_reactions")
      .insert({ comment_id: commentId, user_id: user.id, emoji });
    if (insertError) return fail(500, "INTERNAL", insertError.message);
  }

  const reactionsByComment = await loadCommentReactionGroups(
    db,
    "lead_comment_reactions",
    [commentId],
    user.id,
  );
  const reactions: CommentReactionGroup[] = reactionsByComment.get(commentId) ?? [];
  return ok({ reactions });
}
