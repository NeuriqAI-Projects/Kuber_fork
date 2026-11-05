import { NextRequest, NextResponse } from "next/server";
import { isOpeningSignal } from "@/lib/services/followup-signals";
import { recountCampaignTemperature } from "@/lib/services/campaign-counters";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { createHash } from "crypto";
import { INTEREST_TO_TEMPERATURE } from "@/lib/constants";
import { getInstantlyEmail } from "@/lib/services/instantly";
import { ingestInstantlyEmail } from "@/lib/services/unibox";
import { safeSecretEqual } from "@/lib/auth/secret";
import { findActiveLeadsByEmail } from "@/lib/services/lead-lookup";
import { logLeadEvent, type LeadEventType } from "@/lib/services/lead-events";

export const maxDuration = 60;

const CRM_BY_EVENT: Record<string, string | undefined> = {
  reply_received:    "replied",
  email_bounced:     "failed",
  lead_unsubscribed: "closed",
};

// Instantly's webhook vocabulary → the lead's activity timeline. Anything absent
// here still lands in reply_events; it just isn't worth its own timeline line.
const LEAD_EVENT_BY_INSTANTLY_EVENT: Record<string, { event: LeadEventType; detail: (step: number | null) => string } | undefined> = {
  email_sent:        { event: "email_delivered", detail: (s) => (s && s > 1 ? `Follow-up email delivered (step ${s})` : "Email delivered to the lead's inbox") },
  email_opened:      { event: "email_opened",    detail: () => "Lead opened the email" },
  email_bounced:     { event: "email_bounced",   detail: () => "Email bounced — the address rejected it" },
  reply_received:    { event: "reply_received",  detail: () => "Lead replied" },
  lead_unsubscribed: { event: "unsubscribed",    detail: () => "Lead unsubscribed — outreach stopped for their whole company" },
};

// Instantly's own AI classifies replies into these; each is a timeline line of
// its own so the interest history is traceable, not just the latest value.
const INTEREST_DETAIL_BY_EVENT: Record<string, string | undefined> = {
  lead_interested:        "Marked interested",
  lead_meeting_booked:    "Meeting booked",
  lead_meeting_completed: "Meeting completed",
  lead_closed:            "Marked closed",
  lead_out_of_office:     "Out of office",
  lead_not_interested:    "Marked not interested",
  lead_wrong_person:      "Wrong person — not the right contact",
};

const INTEREST_BY_EVENT: Record<string, number | undefined> = {
  lead_interested:          1,
  lead_meeting_booked:      2,
  lead_meeting_completed:   3,
  lead_closed:              4,
  lead_out_of_office:       0,
  lead_not_interested:      -1,
  lead_wrong_person:        -2,
};

interface InstantlyWebhookPayload {
  event_type?: string;
  timestamp?: string;
  campaign_id?: string;    // Instantly's campaign UUID (our sub-campaign's instantly_campaign_id)
  campaign_name?: string;
  lead_email?: string;
  email_id?: string;       // reply_to_uuid — use to send reply via API
  step?: number;
  variant?: number;
  reply_text?: string;
  reply_html?: string;
  reply_text_snippet?: string;
  reply_subject?: string;
}

/**
 * Strips quoted-reply lines from an email plain-text body so only
 * the new content written by the sender is kept for display.
 * Stops at the first ">" line, "On ... wrote:" attribution, or "--" separator.
 */
function stripQuotedText(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(">")) break;
    if (/^On .+wrote:\s*$/.test(trimmed)) break;
    if (trimmed === "--" || trimmed === "\u2014") break;
    kept.push(line);
  }
  return kept.join("\n").trim() || null;
}

export async function POST(req: NextRequest) {
  // 1) Verify shared secret
  const secret = req.headers.get("x-webhook-secret");
  if (!safeSecretEqual(secret, process.env.INSTANTLY_WEBHOOK_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const p = await req.json().catch(() => null) as InstantlyWebhookPayload | null;
  if (!p?.event_type) return NextResponse.json({ ok: true });

  const db = createAdminClient();
  const receivedAt = p.timestamp ?? new Date().toISOString();
  // replyBody: stripped version for display in the Replies UI (no quoted chain).
  // It is also what the on-demand drafter reads back as the prospect's message.
  const replyBody = stripQuotedText(p.reply_text) ?? p.reply_text_snippet ?? null;

  // 2) Idempotency key (sha256 of timestamp+email+event+email_id)
  const eventUid = createHash("sha256")
    .update(`${receivedAt}|${p.lead_email ?? ""}|${p.event_type}|${p.email_id ?? ""}`)
    .digest("hex");

  // The Unibox mirror needs Instantly's copy of the mail. That GET depends on
  // nothing below, so it starts now and runs alongside the DB work (it used to
  // be the last ~1-2 s of the request). Failure stays non-fatal, as before.
  const mirrorEmail = (p.event_type === "reply_received" || p.event_type === "email_sent") && p.email_id
    ? getInstantlyEmail(p.email_id).then((email) => ({ email }), (error: Error) => ({ error }))
    : null;

  // 3) Resolve Instantly campaign UUID → our sub + master
  //    p.campaign_id here is Instantly's UUID (instantly_campaigns.instantly_campaign_id)
  //    In parallel: the lead, looked up across companies and narrowed to the
  //    campaign's company below, so the two lookups need not wait on each other.
  let subId: string | null = null;
  let masterId: string | null = null;
  let companyId: string | null = null;
  const [subRes, leadMatches] = await Promise.all([
    p.campaign_id
      ? db.from("instantly_campaigns").select("id,campaign_id,company_id").eq("instantly_campaign_id", p.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    findActiveLeadsByEmail(db, p.lead_email),
  ]);
  const sub = subRes.data;
  if (sub) { subId = sub.id; masterId = sub.campaign_id; companyId = sub.company_id; }

  // Both tenants share one Instantly workspace, so Instantly posts every
  // company's replies to this single URL — the handler itself must be
  // cross-company. The sub-campaign is what identifies the owner, so from here
  // on use a client scoped to it: that keeps the lead lookup from matching a
  // same-email lead in the OTHER tenant, and stamps company_id on the rows
  // written below. Falls back to the unscoped client only for events we could
  // not attribute to a campaign at all, which are stored unmapped as before.
  const cdb = companyId ? createScopedClient(companyId) : db;

  // Resolved once and reused below: which lead this event is about. Steps 4/6/7
  // and the activity log all need it, and it cannot change mid-request.
  // Same pick a lookup through cdb makes: the oldest active lead of the
  // campaign's company, or the oldest anywhere for an unattributed event.
  const leadId = (companyId ? leadMatches.find((l) => l.company_id === companyId) : leadMatches[0])?.id ?? null;

  const interest = INTEREST_BY_EVENT[p.event_type];

  // 4) Resolve campaign_lead via master + lead. Its current state comes with
  //    it (read BEFORE patching, for the guards in step 6), and an interest
  //    event's sibling check runs alongside.
  let campaignLeadId: string | null = null;
  type BeforeState = { crm_status: string | null; last_reply_at: string | null; first_sent_at: string | null };
  let beforeState: BeforeState | null = null;
  let siblings: Array<{ id: string; last_reply_at: string | null }> | null = null;
  if (masterId && leadId) {
    const [{ data: cl }, sibRes] = await Promise.all([
      cdb
        .from("campaign_leads")
        .select("id, crm_status, last_reply_at, first_sent_at")
        .eq("campaign_id", masterId)
        .eq("lead_id", leadId)
        .maybeSingle(),
      interest !== undefined
        ? cdb.from("campaign_leads").select("id, last_reply_at").eq("lead_id", leadId)
        : Promise.resolve({ data: null }),
    ]);
    siblings = sibRes.data;
    if (cl) {
      campaignLeadId = cl.id;
      beforeState = cl as BeforeState;
    } else if (p.event_type === "reply_received") {
      // We resolved the exact master campaign AND the lead, but they're no
      // longer linked in campaign_leads — the lead was removed from this
      // campaign (or the sub-campaign reference is stale) since the message
      // was sent. The reply_events row below still keeps the raw event, but
      // this specific "we knew the campaign, still couldn't attribute it"
      // case is worth a visible signal rather than vanishing silently into
      // an unmapped row nobody looks at (review §4.3).
      console.error(
        `[webhook] reply_received: campaign+lead resolved but no active campaign_leads link — ` +
        `master_campaign=${masterId} lead_id=${leadId} lead_email=${p.lead_email}`,
      );
      await cdb.from("audit_log").insert({
        action: "reply_unmapped_stale_campaign_link",
        entity_type: "reply_event",
        diff: { master_campaign_id: masterId, lead_id: leadId, lead_email: p.lead_email, instantly_sub_campaign: p.campaign_id ?? null },
        created_at: new Date().toISOString(),
      });
    }
  }

  // 5) Append event (idempotent — never dropped even if unmapped)
  // ON CONFLICT DO NOTHING ... RETURNING only returns genuinely-inserted rows,
  // so an empty result means Instantly re-delivered an event we already have.
  // The activity log below keys off that: without it, every webhook retry would
  // add another "Reply received" line to the lead's timeline.
  const { data: insertedEvents } = await cdb.from("reply_events").upsert(
    {
      event_uid:              eventUid,
      campaign_id:            masterId,
      instantly_campaign_id:  subId,
      campaign_lead_id:       campaignLeadId,
      event_type:             p.event_type,
      lead_email:             p.lead_email ?? null,
      email_id:               p.email_id ?? null,
      step:                   p.step ?? null,
      variant:                p.variant ?? null,
      reply_body:             replyBody,
      reply_subject:          p.reply_subject ?? null,
      received_at:            receivedAt,
      created_at:             new Date().toISOString(),
    },
    { onConflict: "event_uid", ignoreDuplicates: true },
  ).select("id");
  const isFirstDelivery = (insertedEvents?.length ?? 0) > 0;

  // 6) Update campaign_leads state (with lead_temperature for interest events)
  let interestApplied = false;
  // Steps after the campaign_leads patch only read what it wrote, or touch
  // other rows, so they run concurrently and are awaited together at the end.
  const sideEffects: Array<PromiseLike<unknown>> = [];
  let firstSentKnown = false;
  if (campaignLeadId) {
    // beforeState (step 4) drives the guards below:
    // (1) only count a lead's FIRST reply toward replied_count (a lead replying twice
    //     must not push the reply rate above 100%), and
    // (2) the cross-campaign echo check below.
    const wasAlreadyReplied = beforeState?.crm_status === "replied";

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (CRM_BY_EVENT[p.event_type])                    patch.crm_status = CRM_BY_EVENT[p.event_type];
    if (interest !== undefined) {
      // Instantly classifies "interest" per LEAD, not per campaign thread — when
      // a lead replies in one campaign, it re-broadcasts the SAME classification
      // to every other campaign that lead is currently enrolled in too, even ones
      // they never said anything of the kind in. Confirmed live: two
      // lead_not_interested webhooks arrived 1ms apart for the same lead in two
      // different campaigns, only one of which actually got a negative reply.
      // Only the campaign whose thread is most recently active is trusted;
      // older campaign threads keep whatever status they already had. For a
      // lead in just one campaign (the common case) this is always true.
      let isFreshestThread = true;
      if (siblings && siblings.length > 1) {
        const currentTime = beforeState?.last_reply_at ? new Date(beforeState.last_reply_at).getTime() : -Infinity;
        isFreshestThread = !siblings.some(
          (s) => s.id !== campaignLeadId && s.last_reply_at && new Date(s.last_reply_at).getTime() > currentTime,
        );
      }
      if (isFreshestThread) {
        interestApplied = true;
        patch.interest_status = interest;
        // Instantly's own AI is the sole source of truth for lead_temperature (team
        // decision). We do not run our own LLM classifier on replies — our only LLM
        // pass over a reply is the human-triggered drafter, which never classifies.
        // This is the ONLY place in the codebase that sets lead_temperature.
        const temp = INTEREST_TO_TEMPERATURE[interest as number];
        if (temp) patch.lead_temperature = temp;
      }
    }
    if (p.event_type === "lead_unsubscribed") patch.lead_temperature = "unsubscribed";
    if (p.event_type === "reply_received") {
      patch.last_reply_at   = receivedAt;
      patch.last_reply_body = replyBody;
    }
    // THE moment a mail actually goes out. crm_status was already flipped to
    // 'sent' days earlier when Instantly merely accepted the lead, so this is
    // the only signal that separates "queued in the drip" from "delivered".
    // isFirstDelivery keeps a re-delivered webhook from moving the timestamp.
    // Only the OPENING email's signal starts the clock. If that signal was lost,
    // a follow-up's used to set first_sent_at instead - 18 minutes late for one
    // lead on 2026-09-10 - so every later due date was wrong. The inbox sync
    // now fills the real opening time from Instantly's own copy of the mail.
    if (p.event_type === "email_sent" && isFirstDelivery && !beforeState?.first_sent_at && isOpeningSignal(p.step)) {
      patch.first_sent_at = receivedAt;
    }
    if (Object.keys(patch).length > 1) {
      await cdb.from("campaign_leads").update(patch).eq("id", campaignLeadId);
    }
    // After this the lead has an opening send time either way, so the mirror's
    // first_sent_at backfill below would only re-read it.
    firstSentKnown = !!(beforeState?.first_sent_at || patch.first_sent_at);

    // sent_count is the number every card / analytics tile / reply rate reads,
    // and it now means DELIVERED — so it moves here, on the webhook, not at
    // hand-off time. Guarded the same way replied_count is: only the first
    // delivery for this lead counts.
    if (p.event_type === "email_sent" && masterId && isFirstDelivery && !beforeState?.first_sent_at && isOpeningSignal(p.step)) {
      sideEffects.push(cdb.rpc("increment_campaign_counter", {
        p_campaign_id: masterId,
        p_column: "sent_count",
      }).then(undefined, () => { /* non-fatal — reconcile-counters is the backstop */ }));
    }

    // A bounce leaves the SENT tile and joins the BOUNCED one — the tiles are
    // mutually exclusive outcomes of the same delivered mail, so sent_count is
    // NOT decremented here; the display subtracts bounced_count off it.
    if (p.event_type === "email_bounced" && masterId && isFirstDelivery && beforeState?.crm_status !== "failed") {
      sideEffects.push(cdb.rpc("increment_campaign_counter", {
        p_campaign_id: masterId,
        p_column: "bounced_count",
      }).then(undefined, () => { /* non-fatal — reconcile-counters is the backstop */ }));
    }

    // Increment campaign-level replied_count ONLY the first time this lead replies.
    // Without this guard, a lead who replies twice inflates replied_count past sent_count,
    // producing reply rates above 100% — confirmed bug in test campaigns.
    if (p.event_type === "reply_received" && masterId && !wasAlreadyReplied) {
      sideEffects.push(cdb.rpc("increment_campaign_counter", {
        p_campaign_id: masterId,
        p_column: "replied_count",
      }).then(undefined, () => { /* non-fatal — stat is cosmetic */ }));
    }

    // hot_count / cold_count are recounted, not incremented. Only this path used
    // to count, so a lead the inbox sync had already marked hot (7 minutes before
    // this webhook, on 10 Sep 2026) was never counted: Hot 0 with two hot leads.
    // A recount is right whichever path sets the temperature first, and on any
    // number of duplicate deliveries.
    if (masterId && patch.lead_temperature !== undefined) {
      sideEffects.push(recountCampaignTemperature(cdb, masterId));
    }
  }


  // 6b) Per-lead activity timeline — the human-readable "what happened to this
  // lead" feed in the drawer. Logged off the webhook rather than off our own
  // send call, because this is the point at which the outcome is actually known.
  if (leadId && isFirstDelivery) {
    const mapped = LEAD_EVENT_BY_INSTANTLY_EVENT[p.event_type];
    // Suppressed cross-campaign echoes (see the isFreshestThread check above)
    // don't get a timeline entry for THIS campaign either — logging "Marked not
    // interested" here when it never actually applied would just reproduce the
    // exact confusion this guard exists to prevent.
    const interestDetail = interestApplied ? INTEREST_DETAIL_BY_EVENT[p.event_type] : undefined;
    // One after the other, so the two timeline lines keep their order.
    sideEffects.push((async () => {
      if (mapped) {
        await logLeadEvent(cdb, leadId, mapped.event, mapped.detail(p.step ?? null), {
          metadata: { campaign_id: masterId, step: p.step ?? null, variant: p.variant ?? null },
        });
      }
      if (interestDetail) {
        await logLeadEvent(cdb, leadId, "interest_changed", interestDetail, {
          metadata: { campaign_id: masterId, interest_status: interest ?? null },
        });
      }
    })());
  }

  // 7) Org-level hard opt-out: unsubscribe blocks the whole org
  if (p.event_type === "lead_unsubscribed" && leadId) {
    sideEffects.push((async () => {
      const { data: lead } = await cdb
        .from("leads")
        .select("organization_id")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.organization_id) {
        await cdb
          .from("organizations")
          .update({ unsubscribed: true })
          .eq("id", lead.organization_id);
      }
    })());
  }

  // Unibox mirror ingest (non-fatal)
  if (mirrorEmail) {
    sideEffects.push((async () => {
      try {
        const got = await mirrorEmail;
        if ("error" in got) throw got.error;
        // The upsert above returned the event's id on first delivery; only a
        // re-delivery (nothing returned) still has to look it up.
        const evId = (insertedEvents?.[0]?.id as string | undefined)
          ?? (await cdb.from("reply_events").select("id").eq("event_uid", eventUid).maybeSingle()).data?.id;
        await ingestInstantlyEmail(cdb, got.email, {
          replyEventId: evId,
          masterCampaignId: masterId,
          campaignLeadId: campaignLeadId ?? undefined,
          firstSentKnown: !!campaignLeadId && firstSentKnown,
        });
      } catch (e) {
        console.error("Unibox ingest failed:", (e as Error).message);
      }
    })());
  }

  await Promise.all(sideEffects);

  // NOTE: an inbound reply deliberately does NOT start an AI draft any more.
  // Drafting is human-triggered only, via the "AI draft" button in Unibox /
  // campaign Outbox (POST /api/v1/reply-drafts/generate). Firing it from here
  // burned LLM calls on every reply — including ones nobody ever opened — and
  // pre-empted the reviewer's choice of how to answer. Do not re-add it.

  return NextResponse.json({ ok: true });
}
