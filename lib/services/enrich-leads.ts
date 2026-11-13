import type { SupabaseClient } from "@supabase/supabase-js";
import { bulkMatch } from "@/lib/services/apollo";
import { sleep } from "@/lib/http";
import { normalizeDomain } from "@/lib/utils/domain";

export interface EnrichLeadsResult {
  matched: number;
  verified: number;
  unverified: number;
  archived: number;
  credits_consumed: number;
  missing_apollo_ids: string[];
  enriched_org_ids: string[];
  warning?: string;
  /** True when Apollo rejected the batch for insufficient lead credits (402 or 422). */
  credits_exhausted?: boolean;
  /** True when Apollo rate-limited the batch (429). Not the lead's fault and
   *  NOT retried in-process — see fetchWithRetry's Apollo policy. */
  rate_limited?: boolean;
}

function isApolloCreditsError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const message = (err as Error).message ?? "";
  // Apollo returns 402 on some plans and 422 "insufficient credits" on others
  // (live-confirmed 2026-07-30 against people/bulk_match).
  return status === 402 || (status === 422 && /insufficient credits/i.test(message));
}

/** Apollo is refusing because we asked too fast. The request was still billed,
 *  so it must never be retried in-process; back off and let the next pass
 *  reclaim these leads instead. */
function isApolloRateLimited(err: unknown): boolean {
  return (err as { status?: number }).status === 429;
}

export interface EnrichTarget {
  id: string;          // DB lead UUID
  apollo_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  country: string | null;
  city: string | null;
  state: string | null;
  organization_id: string | null;
  org_name: string | null;
  /** The lead's own tenant. Carried explicitly because the watchdog calls this
   *  with the service-role identity, which gets the UNSCOPED admin client — no
   *  auto-filter on reads, no auto-stamp on writes. Without it, org inserts land
   *  with company_id null (invisible to every scoped read) and updates keyed on
   *  apollo_id hit every tenant's copy of that person. */
  company_id: string | null;
}

// Apollo charges a credit for a bulk_match call EVEN when it comes back
// "unavailable" — confirmed live (see conversation) — and that answer never
// changes on a re-ask (it's Apollo's own data gap, not a transient failure
// like a slow website). So email-reveal is try-once: anyone Apollo doesn't
// hand back a real email for gets archived into `unenrichable_leads` (a flat
// table with no foreign keys into the working schema — never shown in the
// app, never asked about again) and removed from `leads` immediately, instead
// of lingering as "has_email=true, email=null" to be re-charged on every
// future enrichment pass.
// TWO REQUESTS PER PERSON, EVER: the first ask, plus exactly one retry if it
// fails. On the second failure the lead is archived and never asked again.
//
// Apollo bills on receipt, so a failed request has already been paid for and a
// retry is a second charge for the same person. One retry covers a genuine
// one-off blip; anything beyond that is paying repeatedly for the same answer.
// This was 3 until the July 2026 overspend (3,222 credits charged for 1,403
// people) made the account owner's ceiling explicit.
//
// Worst case per person is therefore 2 credits, for life -- and the
// `enrich_attempts < MAX` filter on the candidate query enforces it at the
// point of selection, so it holds even if the archive write itself fails.
//
// The trade-off, stated plainly: a lead that fails twice is not retried a third
// time. It lands in `unenrichable_leads` with reason 'apollo_retry_exhausted',
// where it can be exported and re-imported deliberately -- a human choosing to
// spend a credit, rather than the system spending it automatically.
// pg_cron's resume-apollo-reveal gate repeats this (supabase/migrations/2026_11_05_cron_work_gates.sql).
export const MAX_ENRICH_ATTEMPTS = 2;

/**
 * Take a lead out of the Apollo-eligible pool the instant Apollo answers.
 *
 * A lead is "ask Apollo about this person" precisely when
 * `has_email = true AND email IS NULL`. `has_email` is the SEARCH stage's
 * claim that Apollo holds an address; once bulk_match has actually answered,
 * that claim is spent and must be replaced by the answer itself — otherwise
 * the row still reads as a pending question we have already paid for.
 *
 * This is one field, one statement, and it cannot half-succeed. It runs BEFORE
 * the archive/delete, which is a two-table dance that can. That ordering is the
 * whole point: in July 2026 the archive insert failed on the watchdog's
 * unscoped client, so the delete that depended on it never ran, the row stayed
 * eligible, and Apollo was paid again every fifteen minutes to re-learn the
 * same "no email" answer. With the flag settled first, a failed archive costs
 * us a bookkeeping row — never another credit.
 */
async function settleAsAnswered(db: SupabaseClient, target: EnrichTarget): Promise<void> {
  const { error } = await db.from("leads")
    .update({ has_email: false, enrich_locked_at: null, updated_at: new Date().toISOString() })
    .eq("id", target.id);
  // Swallowing this failure is precisely what keeps a paid-for lead eligible:
  // `has_email` stays true, the next pass re-selects it, and Apollo bills again
  // for an answer we already own. Surface it and let the caller's catch apply
  // the release/archive policy.
  if (error) throw new Error(`settleAsAnswered failed for lead ${target.id}: ${error.message}`);
}

async function archiveUnenrichableLead(
  db: SupabaseClient,
  target: EnrichTarget,
  linkedinUrl?: string | null,
  reason: string = "no_email_available",
): Promise<void> {
  // The unique index is (company_id, apollo_id). A scoped client rewrites
  // onConflict to match, but the watchdog runs as service-role on the UNSCOPED
  // client where nothing is rewritten — so name the real conflict target and
  // carry company_id ourselves. With the old "apollo_id" target that upsert
  // errored on the watchdog path, and because the error was never checked the
  // lead was deleted anyway: gone from `leads`, absent from the do-not-ask
  // list, and free to be re-imported and re-charged later.
  const { error } = await db.from("unenrichable_leads").upsert({
    ...(target.company_id ? { company_id: target.company_id } : {}),
    apollo_id: target.apollo_id,
    first_name: target.first_name,
    last_name: target.last_name,
    title: target.title,
    organization_name: target.org_name,
    country: target.country,
    city: target.city,
    state: target.state,
    linkedin_url: linkedinUrl ?? null,
    reason,
  }, { onConflict: "company_id,apollo_id", ignoreDuplicates: true });

  // Never delete a lead we failed to archive — that is the one path that loses
  // a person entirely AND re-exposes them to a future paid re-import.
  if (error) throw Object.assign(new Error(`unenrichable_leads upsert failed: ${error.message}`), { archiveFailed: true });

  await db.from("leads").delete().eq("id", target.id);

  // This was the org's only lead — an empty company record is just clutter
  // (and would otherwise sit around getting queued/rescraped for nobody).
  if (target.organization_id) {
    const { count } = await db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", target.organization_id)
      .eq("is_deleted", false);
    if ((count ?? 0) === 0) {
      await db.from("organizations").delete().eq("id", target.organization_id);
    }
  }
}

export async function enrichLeads(
  db: SupabaseClient,
  targets: EnrichTarget[],
  chunkSize = 10,
  onProgress?: (processed: number, total: number) => void,
  /** enrich_attempts per lead as returned by claim_unenriched_leads (read
   *  under the claim lock). When it covers every target, the re-read below is
   *  skipped; otherwise it runs as before. */
  attemptsAtClaim?: Map<string, number>,
): Promise<EnrichLeadsResult> {
  let matched = 0;
  let verified = 0;
  let unverified = 0;
  let archived = 0;
  let totalCredits = 0;
  let processedCount = 0;
  const missingApolloIds: string[] = [];
  const enrichedOrgIds = new Set<string>();
  // Every org this run touched — used to conclude the pipeline afterwards so
  // no lead is left showing "New" forever (planning.md Phase 3.2).
  const touchedOrgIds = new Set<string>(
    targets.map((t) => t.organization_id).filter(Boolean) as string[],
  );
  // Orgs whose leads we actually finished resolving (email written or archived).
  // On an Apollo failure mid-batch we only conclude these — never the ones we
  // never got a bulk_match answer for (that was falsely marking hundreds of
  // orgs "No website found" when the real cause was insufficient credits).
  const resolvedOrgIds = new Set<string>();
  let warning: string | undefined;
  let creditsExhausted = false;
  let rateLimited = false;
  // Lead ids we successfully finished this run (matched or archived). On
  // failure we unlock the rest so the next enrich pass can reclaim them
  // instead of waiting out the 10-minute claim lock for nothing.
  const resolvedLeadIds = new Set<string>();
  // Lead ids we actually sent to Apollo. The chunk loop aborts on the first
  // failure, so everything after the failing chunk was never asked about —
  // penalising those with an enrich_attempt (and eventually archiving them
  // as "retry exhausted") threw away leads Apollo had never even seen.
  const attemptedLeadIds = new Set<string>();

  // Attempts are recorded BEFORE each chunk is sent, not in the catch block.
  // Apollo bills on receipt, so "we asked" must be durable even when this
  // function is killed outright (redeploy, timeout, OOM) and no catch ever
  // runs — an unrecorded ask re-selects the lead next pass and pays Apollo
  // again for an answer already bought, which is exactly the July 2026 failure
  // mode with a smaller blast radius. A recorded-but-unanswered ask merely
  // wastes one of the lead's two lifetime slots: the safe direction. Chunks
  // Apollo refused wholesale (credits gone, rate limit) are reverted in the
  // catch block, preserving the "not the lead's fault" release policy.
  const preAttempts = new Map<string, number>();
  if (attemptsAtClaim && targets.every((t) => attemptsAtClaim.has(t.id))) {
    for (const t of targets) preAttempts.set(t.id, attemptsAtClaim.get(t.id)!);
  } else {
    const { data } = await db
      .from("leads")
      .select("id, enrich_attempts")
      .in("id", targets.map((t) => t.id));
    for (const r of data ?? []) {
      preAttempts.set(r.id as string, (r.enrich_attempts as number) ?? 0);
    }
  }

  /** Writes per-lead attempt values grouped by value (one UPDATE per distinct
   *  value — in practice a single statement, since a chunk's leads almost
   *  always share a count). Throws on the first write error so an unrecorded
   *  ask can never reach Apollo. */
  const writeAttempts = async (ids: string[], valueOf: (id: string) => number) => {
    const groups = new Map<number, string[]>();
    for (const id of ids) {
      const v = valueOf(id);
      const g = groups.get(v);
      if (g) g.push(id); else groups.set(v, [id]);
    }
    for (const [value, groupIds] of groups) {
      const { error } = await db
        .from("leads")
        .update({ enrich_attempts: value })
        .in("id", groupIds);
      if (error) throw new Error(`enrich_attempts write failed: ${error.message}`);
    }
  };

  try {
    for (let i = 0; i < targets.length; i += chunkSize) {
      const chunkTargets = targets.slice(i, i + chunkSize);
      const chunkDetails = chunkTargets.map((t) => ({
        id: t.apollo_id,
        first_name: t.first_name ?? undefined,
        organization_name: t.org_name ?? undefined,
      }));

      // Record the ask first (see preAttempts above). If this write fails the
      // chunk aborts before Apollo is called — the leads were never sent, are
      // not in attemptedLeadIds, and are released unpenalised by the catch.
      await writeAttempts(
        chunkTargets.map((t) => t.id),
        (id) => (preAttempts.get(id) ?? 0) + 1,
      );
      for (const t of chunkTargets) attemptedLeadIds.add(t.id);
      const result = await bulkMatch(chunkDetails);
      totalCredits += result.credits_consumed ?? 0;

      const seenApolloIds = new Set<string>();

      for (const match of result.matches ?? []) {
        const lead = chunkTargets.find((t) => t.apollo_id === match.id);
        if (!lead) continue;
        seenApolloIds.add(match.id);

        if (match.email == null) {
          // Apollo acknowledged the person but has no email on file. That answer
          // is final, and we have already paid for it.
          await settleAsAnswered(db, lead);
          await archiveUnenrichableLead(db, lead, match.linkedin_url);
          archived++;
          resolvedLeadIds.add(lead.id);
          if (lead.organization_id) resolvedOrgIds.add(lead.organization_id);
          continue;
        }

        // NOTE: `matched`/`verified` are counted only once the email is actually
        // written (below). They used to be incremented here, which reported a
        // paid match as a success even when the write that followed was rejected
        // and dropped — the 8 Aug 2026 charge logged "matched: 1, verified: 1"
        // for a lead whose email never landed.

        // Org upsert-merge (§4.2 rule)
        let orgId = lead.organization_id;

        // Every org read below is pinned to the lead's own tenant. On the scoped
        // client the proxy already does this; on the service-role path it does
        // not, and `apollo_org_id` is only unique per company — so an unpinned
        // .maybeSingle() ERRORS as soon as two tenants hold the same Apollo org,
        // silently falls through, and creates a duplicate org.
        if (match.organization_id && match.organization) {
          const byApolloOrgQuery = db
            .from("organizations")
            .select("id")
            .eq("apollo_org_id", match.organization_id);
          if (lead.company_id) byApolloOrgQuery.eq("company_id", lead.company_id);
          const { data: byApolloOrg } = await byApolloOrgQuery.maybeSingle();

          if (byApolloOrg) {
            orgId = byApolloOrg.id;
            await db.from("organizations").update({
              name: match.organization.name ?? undefined,
              domain: match.organization.primary_domain ? normalizeDomain(match.organization.primary_domain) : undefined,
              domain_source: match.organization.primary_domain ? "apollo" : undefined,
              website: match.organization.website_url ?? undefined,
              industry: match.organization.industry ?? undefined,
              keywords: match.organization.keywords ?? undefined,
              employees: match.organization.estimated_num_employees ?? undefined,
              city: match.organization.city ?? undefined,
              country: match.organization.country ?? undefined,
              updated_at: new Date().toISOString(),
            }).eq("id", byApolloOrg.id);
          } else {
            const byNameQuery = db
              .from("organizations")
              .select("id")
              .ilike("name", match.organization.name ?? "")
              .is("apollo_org_id", null);
            if (lead.company_id) byNameQuery.eq("company_id", lead.company_id);
            const { data: byName } = await byNameQuery.maybeSingle();

            if (byName) {
              orgId = byName.id;
              await db.from("organizations").update({
                apollo_org_id: match.organization_id,
                domain: match.organization.primary_domain ? normalizeDomain(match.organization.primary_domain) : undefined,
                domain_source: match.organization.primary_domain ? "apollo" : undefined,
                website: match.organization.website_url ?? undefined,
                industry: match.organization.industry ?? undefined,
                keywords: match.organization.keywords ?? undefined,
                employees: match.organization.estimated_num_employees ?? undefined,
                city: match.organization.city ?? undefined,
                country: match.organization.country ?? undefined,
                updated_at: new Date().toISOString(),
              }).eq("id", byName.id);
            } else {
              const { data: newOrg } = await db.from("organizations").insert({
                // Stamped explicitly: the service-role path is unscoped, and an
                // org written with company_id null is invisible to every scoped
                // read for the rest of its life.
                ...(lead.company_id ? { company_id: lead.company_id } : {}),
                apollo_org_id: match.organization_id,
                name: match.organization.name ?? "Unknown",
                domain: match.organization.primary_domain ? normalizeDomain(match.organization.primary_domain) : null,
                domain_source: match.organization.primary_domain ? "apollo" : null,
                website: match.organization.website_url ?? null,
                industry: match.organization.industry ?? null,
                keywords: match.organization.keywords ?? null,
                employees: match.organization.estimated_num_employees ?? null,
                city: match.organization.city ?? null,
                country: match.organization.country ?? null,
                // Same queue stamp as every other org insert. Left out, the row
                // was queued with status and updated_at NULL, which the claim and
                // the 24 h clean-up both skipped: 2 client orgs sat a week (13 Nov).
                enrichment_stage: "queued",
                enrichment_status: "SCRAPE_QUEUED",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }).select("id").single();
              if (newOrg) orgId = newOrg.id;
            }
          }
        }

        if (orgId && match.organization?.primary_domain) {
          await db.from("organizations")
            .update({
              domain: normalizeDomain(match.organization.primary_domain),
              domain_source: "apollo",
              ...(match.organization_id ? { apollo_org_id: match.organization_id } : {}),
              ...(match.organization.website_url ? { website: match.organization.website_url } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("id", orgId)
            .is("domain", null);

          await db.from("leads")
            .update({ status: "new", updated_at: new Date().toISOString() })
            .eq("organization_id", orgId)
            .eq("status", "input_required")
            .eq("is_deleted", false)
            .not("email", "is", null);
        }

        if (orgId) {
          enrichedOrgIds.add(orgId);
          touchedOrgIds.add(orgId);
          resolvedOrgIds.add(orgId);
        }
        resolvedLeadIds.add(lead.id);

        // Only overwrite fields the match actually returned. A partial Apollo re-match
        // must NOT erase previously-good values with null (§3.1).
        const leadUpdate: Record<string, unknown> = {
          organization_id: orgId,
          updated_at: new Date().toISOString(),
        };
        if (match.last_name != null) leadUpdate.last_name = match.last_name;
        if (match.email != null) leadUpdate.email = match.email.toLowerCase();
        if (match.email_status != null) leadUpdate.email_status = match.email_status;
        if (match.headline != null) leadUpdate.headline = match.headline;
        if (match.linkedin_url != null) leadUpdate.linkedin_url = match.linkedin_url;
        if (match.city != null) leadUpdate.city = match.city;
        if (match.state != null) leadUpdate.state = match.state;
        if (match.country != null) leadUpdate.country = match.country;
        if (match.time_zone != null) leadUpdate.time_zone = match.time_zone;
        if (match.email_domain_catchall != null) leadUpdate.email_domain_catchall = match.email_domain_catchall;
        if (match.seniority != null) leadUpdate.seniority = match.seniority;
        if (match.departments != null) leadUpdate.departments = match.departments;
        if (match.is_likely_to_engage != null) leadUpdate.is_likely_to_engage = match.is_likely_to_engage;
        // Keyed on the lead's own id, not apollo_id. `apollo_id` is unique only
        // per company, so an unscoped update keyed on it wrote this email into
        // every tenant holding the same person — a cross-tenant write on the
        // watchdog path, and one that silently masked duplicate spend.
        const { error: writeError } = await db.from("leads").update(leadUpdate).eq("id", lead.id);
        if (writeError) {
          // 23505 = unique violation, in practice always
          // `leads_company_lower_email_active_uidx`: Apollo handed back a real
          // address that this TENANT (not just this org) already holds on
          // another active lead — two Apollo person records sharing one mailbox.
          // The answer is final and already paid for, and re-asking buys the
          // identical collision, so settle it on exactly the same terms as "no
          // email on file". Previously this error was never read: the credit was
          // spent, the email discarded, and the lead left `has_email = true /
          // email = null` — still eligible, to be billed again next pass.
          if (writeError.code === "23505") {
            await settleAsAnswered(db, lead);
            await archiveUnenrichableLead(db, lead, match.linkedin_url, "duplicate_email");
            archived++;
            resolvedLeadIds.add(lead.id);
            if (lead.organization_id) resolvedOrgIds.add(lead.organization_id);
            continue;
          }
          // Anything else is a genuine write failure on a request we have paid
          // for. Never swallow it — throwing hands it to the catch below, which
          // records it and applies the release/archive policy.
          throw new Error(`lead email write failed for ${lead.id}: ${writeError.message}`);
        }

        matched++;
        if (match.email_status === "verified") verified++; else unverified++;

        // Only reset the CRM status of leads still in a pre-send stage — never clobber
        // a lead that's already sent/replied/won in another campaign (§3.1).
        const crm = match.email_status === "verified" ? "enriched" : "skipped";
        await db.from("campaign_leads")
          .update({ crm_status: crm, updated_at: new Date().toISOString() })
          .eq("lead_id", lead.id)
          .in("crm_status", ["new", "enriching", "enriched", "skipped"]);
      }

      // Targets Apollo didn't return a record for at all — same final "no
      // email, ever" outcome as an explicit null-email match, and just as paid
      // for, so they are settled and archived on the same terms.
      for (const target of chunkTargets) {
        if (!seenApolloIds.has(target.apollo_id)) {
          await settleAsAnswered(db, target);
          await archiveUnenrichableLead(db, target);
          archived++;
          resolvedLeadIds.add(target.id);
          if (target.organization_id) resolvedOrgIds.add(target.organization_id);
        }
      }

      processedCount += chunkTargets.length;
      onProgress?.(processedCount, targets.length);

      if (i + chunkSize < targets.length) await sleep(500);
    }
  } catch (err) {
    creditsExhausted = isApolloCreditsError(err);
    rateLimited = isApolloRateLimited(err);
    warning = creditsExhausted
      ? `Credits exhausted after ${matched} matched`
      : rateLimited
        ? `Apollo rate-limited the batch after ${matched} matched — released for the next pass`
        : (err as Error).message;

    const unresolved = targets.filter((t) => !resolvedLeadIds.has(t.id));
    // The loop aborts on the first bad chunk, so everything after it was never
    // sent. Those leads must not be penalised for a failure they had no part
    // in — previously they collected an attempt each and were eventually
    // archived as "retry exhausted" without Apollo ever having seen them.
    const untouched = unresolved.filter((t) => !attemptedLeadIds.has(t.id));
    const attempted = unresolved.filter((t) => attemptedLeadIds.has(t.id));

    // Released with no penalty: a billing gap, a rate limit, or a chunk we
    // never got to. None of these say anything about the lead itself.
    const releaseUnpenalised = creditsExhausted || rateLimited
      ? unresolved
      : untouched;
    if (releaseUnpenalised.length > 0) {
      await db.from("leads").update({ enrich_locked_at: null })
        .in("id", releaseUnpenalised.map((t) => t.id)).is("email", null);
    }

    if ((creditsExhausted || rateLimited) && attempted.length > 0) {
      // The ask was recorded before the request went out, but a wholesale
      // refusal (empty balance, rate limit) is Apollo's state, not the lead's
      // — put their counters back so the refusal doesn't burn a lifetime slot.
      // If the process dies before this revert lands, the recorded ask stands:
      // that wastes a slot at worst, and never re-bills.
      const stillPending = attempted.filter((t) => !resolvedLeadIds.has(t.id));
      if (stillPending.length > 0) {
        await writeAttempts(
          stillPending.map((t) => t.id),
          (id) => preAttempts.get(id) ?? 0,
        );
      }
    }

    if (!creditsExhausted && !rateLimited && attempted.length > 0) {
      // A genuine per-request failure (Apollo timeout/5xx/network, not credits
      // or a rate limit) on a request Apollo actually received — so it was
      // already paid for. The ask is already on the counter (recorded before
      // the request), so nothing to bump here: leads at the ceiling are
      // archived for good, the rest are released for their one retry. The
      // `enrich_attempts < MAX` filter on the candidate query enforces the
      // same ceiling at selection time, so it holds even if the archive fails.
      const { data: current } = await db.from("leads")
        .select("id, enrich_attempts")
        .in("id", attempted.map((t) => t.id));
      const attemptsById = new Map(
        (current ?? []).map((r) => [r.id as string, (r.enrich_attempts as number) ?? 0]),
      );

      const toArchive = attempted.filter(
        (t) => (attemptsById.get(t.id) ?? 0) >= MAX_ENRICH_ATTEMPTS,
      );
      const toRelease = attempted.filter(
        (t) => (attemptsById.get(t.id) ?? 0) < MAX_ENRICH_ATTEMPTS,
      );

      for (const target of toArchive) {
        // Out of attempts: settle it first, exactly like a "no email" answer.
        // Whatever happens to the archive after this, the lead is no longer an
        // Apollo question and can never be billed for again.
        await settleAsAnswered(db, target);
        try {
          await archiveUnenrichableLead(db, target, null, "apollo_retry_exhausted");
          archived++;
          resolvedLeadIds.add(target.id);
          if (target.organization_id) resolvedOrgIds.add(target.organization_id);
        } catch {
          // Bookkeeping row lost, nothing else. The lead is already settled.
        }
      }
      if (toArchive.length > 0) {
        await db.from("enrichment_logs").insert({
          source: "apollo",
          event: "APOLLO_RETRY_EXHAUSTED",
          error: warning?.slice(0, 500) ?? null,
          payload: {
            archived_lead_ids: toArchive.map((t) => t.id),
            max_attempts: MAX_ENRICH_ATTEMPTS,
          },
        });
      }

      if (toRelease.length > 0) {
        await db.from("leads")
          .update({ enrich_locked_at: null })
          .in("id", toRelease.map((t) => t.id)).is("email", null);
      }
    }
  }

  // ── Conclude the pipeline for orgs we actually finished ───────────────────
  // "New" now means "enrichment in flight", so a completed bulk-match run must
  // leave no org dangling: revive previously-failed orgs that just gained a
  // domain (they'll be scraped), and mark still-domainless orgs failed so their
  // leads move to Input Required instead of sitting in New forever.
  //
  // CRITICAL: if Apollo failed mid-batch (credits / 5xx / auth), do NOT mark the
  // unprocessed orgs "No website found" — that was the demo-breaking bug where
  // a 422 insufficient-credits response flipped hundreds of leads to Input
  // Required with zero emails written. Only conclude orgs we resolved.
  const orgsToConclude = warning ? resolvedOrgIds : touchedOrgIds;
  if (orgsToConclude.size > 0) {
    const ids = [...orgsToConclude];
    const now = new Date().toISOString();

    await db.from("organizations")
      .update({
        enrichment_stage: "queued",
        enrichment_status: "SCRAPE_QUEUED",
        last_error: null,
        updated_at: now,
      })
      .in("id", ids)
      .eq("enrichment_stage", "failed")
      .not("domain", "is", null)
      .or("enrichment_attempts.is.null,enrichment_attempts.lt.3");

    await db.from("organizations")
      .update({
        enrichment_stage: "failed",
        enrichment_status: "No website found",
        enrichment_done_at: now,
        updated_at: now,
      })
      .in("id", ids)
      .is("domain", null)
      .in("enrichment_stage", ["queued", "scraping"]);
  }

  // Collect missing (still no email after enrichment) — should stay empty in
  // practice now that unresolved targets are archived+removed above; kept as
  // a defensive check in case a target somehow survived without resolution.
  const allApolloIds = targets.map((t) => t.apollo_id);
  const { data: stillMissing } = await db
    .from("leads")
    .select("apollo_id")
    .in("apollo_id", allApolloIds)
    .is("email", null);
  missingApolloIds.push(...(stillMissing ?? []).map((r) => r.apollo_id));

  return {
    matched,
    verified,
    unverified,
    archived,
    credits_consumed: totalCredits,
    missing_apollo_ids: missingApolloIds,
    enriched_org_ids: [...enrichedOrgIds],
    ...(warning ? { warning } : {}),
    ...(creditsExhausted ? { credits_exhausted: true } : {}),
    ...(rateLimited ? { rate_limited: true } : {}),
  };
}
