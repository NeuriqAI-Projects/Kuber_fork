import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCustomVariables, updateInstantlyLeadVariables } from "@/lib/services/instantly";

export type InstantlySyncResult = { attempted: boolean; synced: boolean; error?: string };

/**
 * If this lead was already pushed to Instantly (has instantly_lead_id), push
 * an approved draft's content there too — Instantly only reads custom_variables
 * once, at the initial add, and never again on its own. Without this, approving
 * a follow-up draft after the lead's initial send silently never reaches Instantly.
 */
export async function syncApprovedDraftToInstantly(
  db: SupabaseClient,
  leadId: string,
  campaignId: string,
  /** What the caller already read (the follow-up writer has both for every
   *  lead of a run), so they are not read again per lead. */
  known?: { instantlyLeadId?: string | null; senderName?: string | null },
): Promise<InstantlySyncResult> {
  const instantlyLeadId = known?.instantlyLeadId !== undefined
    ? known.instantlyLeadId
    : (await db
      .from("campaign_leads")
      .select("instantly_lead_id")
      .eq("campaign_id", campaignId)
      .eq("lead_id", leadId)
      .maybeSingle()).data?.instantly_lead_id as string | null | undefined;

  if (!instantlyLeadId) return { attempted: false, synced: false }; // not sent yet — initial push will carry current drafts

  const [senderName, { data: drafts }] = await Promise.all([
    known?.senderName !== undefined
      ? known.senderName
      : db.from("campaigns").select("sender_name").eq("id", campaignId).maybeSingle().then(({ data }) => data?.sender_name as string | null | undefined),
    db.from("email_drafts")
      .select("step_number, subject, body, version")
      .eq("campaign_id", campaignId)
      .eq("lead_id", leadId)
      .in("status", ["approved", "sent"]),
  ]);

  if (!drafts || drafts.length === 0) return { attempted: false, synced: false };

  // Keep only the HIGHEST version per step. Without this, approved + sent rows for
  // the same step coexist and buildCustomVariables lets the last row win — which
  // could push an OLDER version than the one just approved. (Matches sendCampaign.)
  const activeByStep = new Map<number, { step_number: number; subject: string | null; body: string | null }>();
  for (const d of [...drafts].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))) {
    if (!activeByStep.has(d.step_number)) {
      activeByStep.set(d.step_number, { step_number: d.step_number, subject: d.subject, body: d.body });
    }
  }

  const customVariables = buildCustomVariables([...activeByStep.values()], senderName);
  try {
    await updateInstantlyLeadVariables(instantlyLeadId, customVariables);
    return { attempted: true, synced: true };
  } catch (e) {
    console.error("updateInstantlyLeadVariables failed:", e);
    return { attempted: true, synced: false, error: (e as Error).message };
  }
}
