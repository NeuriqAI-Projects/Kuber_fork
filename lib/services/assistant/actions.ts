// Assistant actions: propose → user clicks Confirm → execute.
//
// The model can only PROPOSE. A proposal is a signed, short-lived token that
// names exactly what will happen (which leads, which campaign). Nothing changes
// until the user presses Confirm, which posts the token to
// /api/v1/assistant/actions. There the token is checked against the caller
// (same user, same company, not expired, not used) and the change is made by
// calling the app's own API routes with the user's own session — so an action
// gets exactly the validation, permissions and activity logging the normal UI
// gets, and there is no second copy of that logic to drift.
import { SignJWT, jwtVerify } from "jose";
import type { AssistantCaller } from "@/lib/services/assistant/context";

export type ActionPayload =
  | { kind: "create_campaign"; name: string; daily_limit: number; lead_ids: string[] }
  | { kind: "add_to_campaign"; campaign_id: string; campaign_name: string; lead_ids: string[] }
  | { kind: "assign_leads"; lead_ids: string[]; strategy: "manual" | "round_robin"; assigned_to: string | null; assignee_name: string }
  | { kind: "pause_campaign" | "resume_campaign" | "generate_drafts"; campaign_id: string; campaign_name: string }
  | { kind: "enrich_leads"; lead_ids: string[] }
  | { kind: "add_note"; lead_id: string; lead_name: string; text: string }
  | { kind: "draft_reply"; thread_id: string; lead_name: string; instruction: string | null };

export type ActionKind = ActionPayload["kind"];

/** What the confirm card shows. `token` is the only thing the client sends back. */
export type ActionProposal = {
  token: string;
  kind: ActionKind;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  /** Apollo credits this action will spend, when it spends any. */
  apollo_credits?: number;
  /** Uses the AI provider (drafts) — shown as a cost hint, never blocks. */
  uses_ai?: boolean;
  confirm_label: string;
};

export type ActionResult = { ok: boolean; message: string; link?: string; data?: Record<string, unknown> };

const PROPOSAL_TTL = "30m";
const ISSUER = "kuber-assistant";

function signingKey(): Uint8Array {
  const secret = process.env.INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("INTERNAL_SECRET is not set — assistant actions are disabled");
  return new TextEncoder().encode(`assistant-actions:${secret}`);
}

export async function signProposal(caller: AssistantCaller, payload: ActionPayload): Promise<string> {
  return new SignJWT({ p: payload, cid: caller.companyId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(caller.userId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(PROPOSAL_TTL)
    .sign(signingKey());
}

/** Tokens already executed on this instance. A double click must not create two campaigns. */
const usedTokens = new Map<string, number>();

export async function verifyProposal(
  caller: AssistantCaller,
  token: string,
): Promise<{ payload: ActionPayload; jti: string } | { error: string }> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), { issuer: ISSUER });
    if (payload.sub !== caller.userId || payload.cid !== caller.companyId) {
      return { error: "This action was proposed for someone else." };
    }
    const jti = String(payload.jti ?? "");
    if (!jti || usedTokens.has(jti)) return { error: "This action was already done." };
    return { payload: payload.p as ActionPayload, jti };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    return { error: /exp/i.test(msg) ? "This proposal expired. Ask again to get a fresh one." : "Invalid action." };
  }
}

function markUsed(jti: string) {
  const now = Date.now();
  usedTokens.set(jti, now);
  // Tokens live 30 minutes; forget anything older than an hour.
  for (const [k, t] of usedTokens) if (now - t > 3_600_000) usedTokens.delete(k);
}

async function callApi<T = Record<string, unknown>>(
  caller: AssistantCaller,
  method: "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const res = await fetch(`${caller.baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${caller.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(55_000),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.success) {
    return { ok: false, message: json?.error?.message ?? `Request failed (HTTP ${res.status})` };
  }
  return { ok: true, data: json.data as T };
}

type AddLeadsResult = {
  added: string[]; not_found: string[]; blocked_unsubscribed: string[]; blocked_not_enriched: string[]; skipped_existing: string[];
};

function addLeadsMessage(r: AddLeadsResult): string {
  const parts = [`${r.added.length} added`];
  if (r.skipped_existing.length) parts.push(`${r.skipped_existing.length} already in it`);
  if (r.blocked_not_enriched.length) parts.push(`${r.blocked_not_enriched.length} not ready (no email / not enriched)`);
  if (r.blocked_unsubscribed.length) parts.push(`${r.blocked_unsubscribed.length} unsubscribed`);
  if (r.not_found.length) parts.push(`${r.not_found.length} not found`);
  return parts.join(", ");
}

const ADD_CHUNK = 250;

async function addLeadsInChunks(caller: AssistantCaller, campaignId: string, leadIds: string[]): Promise<AddLeadsResult | { error: string }> {
  const total: AddLeadsResult = { added: [], not_found: [], blocked_unsubscribed: [], blocked_not_enriched: [], skipped_existing: [] };
  for (let i = 0; i < leadIds.length; i += ADD_CHUNK) {
    const r = await callApi<AddLeadsResult>(caller, "POST", `/api/v1/campaigns/${campaignId}/leads`, { lead_ids: leadIds.slice(i, i + ADD_CHUNK) });
    if (!r.ok) return { error: r.message };
    for (const k of Object.keys(total) as Array<keyof AddLeadsResult>) total[k].push(...(r.data[k] ?? []));
  }
  return total;
}

export async function executeAction(caller: AssistantCaller, token: string): Promise<ActionResult> {
  const v = await verifyProposal(caller, token);
  if ("error" in v) return { ok: false, message: v.error };
  const p = v.payload;
  // Mark before running: a second click while the first is still in flight must be refused too.
  markUsed(v.jti);

  switch (p.kind) {
    case "create_campaign": {
      const created = await callApi<{ id: string; name: string }>(caller, "POST", "/api/v1/campaigns", {
        name: p.name, daily_limit: p.daily_limit, human_in_loop: true, send_mode: "now",
      });
      if (!created.ok) return { ok: false, message: `Could not create the campaign: ${created.message}` };
      const added = await addLeadsInChunks(caller, created.data.id, p.lead_ids);
      if ("error" in added) {
        return { ok: false, message: `Campaign "${p.name}" was created, but adding leads failed: ${added.error}`, link: `/campaigns/${created.data.id}` };
      }
      return {
        ok: true,
        message: `Created draft campaign "${p.name}" — ${addLeadsMessage(added)}. Nothing is sent until you set it up and start it.`,
        link: `/campaigns/${created.data.id}`,
        data: { campaign_id: created.data.id, added: added.added.length },
      };
    }
    case "add_to_campaign": {
      const added = await addLeadsInChunks(caller, p.campaign_id, p.lead_ids);
      if ("error" in added) return { ok: false, message: added.error };
      return { ok: true, message: `"${p.campaign_name}": ${addLeadsMessage(added)}.`, link: `/campaigns/${p.campaign_id}`, data: { added: added.added.length } };
    }
    case "assign_leads": {
      const body = p.strategy === "round_robin"
        ? { strategy: "round_robin", ids: p.lead_ids }
        : { strategy: "manual", ids: p.lead_ids, assigned_to: p.assigned_to };
      const r = await callApi(caller, "POST", "/api/v1/leads/bulk-assign", body);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `${p.lead_ids.length} leads ${p.strategy === "round_robin" ? "shared out round-robin" : `assigned to ${p.assignee_name}`}.`, data: r.data };
    }
    case "pause_campaign":
    case "resume_campaign": {
      const verb = p.kind === "pause_campaign" ? "pause" : "resume";
      const r = await callApi(caller, "POST", `/api/v1/campaigns/${p.campaign_id}/${verb}`);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `"${p.campaign_name}" ${verb === "pause" ? "paused" : "resumed"}.`, link: `/campaigns/${p.campaign_id}` };
    }
    case "generate_drafts": {
      const r = await callApi(caller, "POST", `/api/v1/campaigns/${p.campaign_id}/generate-drafts`);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `Writing drafts for "${p.campaign_name}" now. They appear in the campaign as they finish.`, link: `/campaigns/${p.campaign_id}` };
    }
    case "enrich_leads": {
      const r = await callApi<{ requested?: number; credits_consumed?: number }>(caller, "POST", "/api/v1/leads/enrich", { lead_ids: p.lead_ids });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `Email reveal started for ${r.data.requested ?? p.lead_ids.length} leads.`, data: r.data };
    }
    case "add_note": {
      const r = await callApi(caller, "POST", `/api/v1/leads/${p.lead_id}/comments`, { body: p.text });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `Note added to ${p.lead_name}.`, link: `/leads/${p.lead_id}` };
    }
    case "draft_reply": {
      const r = await callApi(caller, "POST", "/api/v1/reply-drafts/generate", { thread_id: p.thread_id, instruction: p.instruction ?? undefined });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `Reply draft for ${p.lead_name} is ready in Unibox. It is NOT sent — review and send it there.`, link: `/unibox?thread=${encodeURIComponent(p.thread_id)}` };
    }
  }
}
