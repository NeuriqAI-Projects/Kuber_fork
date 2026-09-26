/**
 * Builds five [TEST] campaigns on fake data in the Dev workspace, owned by
 * Lakshit, for walking through the drafting screens by hand. No AI credits and
 * no real email: [TEST] campaigns use the fake AI and a fake send (llm-mock.ts),
 * and every address is @*.example.com, a domain reserved so it never receives mail.
 *
 * Runs against a LOCAL server (the fake AI lives in this branch's code):
 *   npx next dev -p 3100   (with .env.vercel loaded)
 *   npx tsx --env-file=.env.vercel scripts/seed-ui-test-campaigns.ts
 *
 * Re-running adds another set; delete old ones from the Campaigns page.
 */
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.SEED_BASE_URL ?? "http://localhost:3100";
const DEV = "00000000-0000-0000-0000-00000000000a";
const LAKSHIT_EMAIL = "lakshit@gmail.com";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const o = { auth: { persistSession: false } };
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, o);
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, o);

const FIRST = ["Lucia", "Mateo", "Sofia", "Diego", "Valentina", "Andres", "Camila", "Javier", "Isabella", "Tomas", "Mariana", "Pablo", "Daniela", "Rafael", "Elena", "Hugo", "Paula", "Nicolas", "Carla", "Martin"];
const LAST = ["Ortega", "Ramos", "Vidal", "Castro", "Navarro", "Molina", "Suarez", "Herrera", "Rojas", "Paredes", "Quiroga", "Salazar", "Mendez", "Fuentes", "Cabrera", "Ibarra", "Lozano", "Varela", "Duarte", "Aguirre"];
const WORDS = ["Andes", "Pacifico", "Norte", "Sierra", "Delta", "Condor", "Aurora", "Litoral", "Plata", "Selva", "Horizonte", "Cumbre", "Brisa", "Solar", "Rio"];
const KINDS = ["Flexibles", "Films", "Pack", "Envases", "Polimeros", "Embalajes"];
const COUNTRIES = [["Mexico", "Monterrey"], ["Chile", "Santiago"], ["Peru", "Lima"], ["Colombia", "Bogota"], ["Brazil", "Sao Paulo"], ["Argentina", "Rosario"]];
const TITLES = ["Purchasing Manager", "Plant Manager", "Operations Manager", "Procurement Head", "Technical Director"];

let n = 0;
const run = Date.now().toString(36).slice(-4);

async function makeLeads(count: number, lakshitId: string, opts: { failEvery?: number } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++, n++) {
    const company = `${WORDS[n % WORDS.length]} ${KINDS[n % KINDS.length]} ${run}${n}`;
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const [country, city] = COUNTRIES[n % COUNTRIES.length];
    const first = FIRST[n % FIRST.length];
    const last = LAST[(n * 7) % LAST.length];
    const fail = opts.failEvery && i % opts.failEvery === 0;
    const { data: org, error: oe } = await admin.from("organizations").insert({
      company_id: DEV, name: `${company} (Test)`, domain: `${slug}.example.com`, website: `https://${slug}.example.com`,
      industry: "packaging", employees: 80 + n, city, country, has_scraped: true,
      company_description: `${company} is a fictional flexible packaging converter in ${city} making printed films and pouches for food brands. Test data.`,
      sells_to: "food and beverage brands", enrichment_status: "ENRICHMENT_COMPLETE", enrichment_stage: "done",
      enrichment_done_at: new Date().toISOString(),
    }).select("id").single();
    if (oe) throw new Error(`org: ${oe.message}`);
    const email = `${first}.${last}${fail ? ".aifail" : ""}@${slug}.example.com`.toLowerCase();
    const { data: lead, error: le } = await admin.from("leads").insert({
      company_id: DEV, organization_id: org.id, apollo_id: `test-${run}-${n}`, first_name: first, last_name: last, email,
      email_status: "verified", has_email: true, title: TITLES[n % TITLES.length], city, country,
      status: "enriched", lead_source: "manual", created_by: lakshitId, assigned_to: lakshitId,
      assigned_at: new Date().toISOString(),
    }).select("id").single();
    if (le) throw new Error(`lead: ${le.message}`);
    ids.push(lead.id);
  }
  return ids;
}

let token = "";
async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json.data as T;
}

async function createCampaign(name: string, leadIds: string[]) {
  const c = await api<{ id: string }>("/api/v1/campaigns", "POST", {
    name, human_in_loop: true, daily_limit: 30, window_from: "09:00", window_to: "18:00",
    schedule_timezone: "America/Mexico_City", send_mode: "now",
    send_days: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
    followup_steps: [{ delay: 3, delay_unit: "days" }, { delay: 7, delay_unit: "days" }],
  });
  await api(`/api/v1/campaigns/${c.id}/leads`, "POST", { lead_ids: leadIds });
  return c.id;
}

async function draftAndWait(id: string, label: string) {
  await api(`/api/v1/campaigns/${id}/generate-drafts`, "POST");
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const p = await api<any>(`/api/v1/campaigns/${id}/draft-progress`);
    process.stdout.write(`\r  ${label}: ${p.draft + p.approved} written, ${p.pending} waiting, ${p.generating} writing   `);
    if (p.pending + p.generating === 0 || (p.ai_available === false && p.generating === 0)) break;
    // The self-chain dies after a few hops, same as production; nudge it the
    // way the open drawer does.
    if (i % 15 === 14) await api(`/api/v1/campaigns/${id}/generate-drafts/kick`, "POST").catch(() => {});
  }
  console.log();
}

async function draftIds(id: string, limit: number) {
  const { campaign_leads } = await api<any>(`/api/v1/campaigns/${id}/leads?limit=200`);
  return (campaign_leads as any[]).filter((cl) => cl.email_drafts?.status === "draft" && cl.email_drafts?.source !== "template")
    .slice(0, limit).map((cl) => ({ draft: cl.email_drafts.id as string, cl: cl.id as string }));
}

async function main() {
  const { data: prof } = await admin.from("profiles").select("id").eq("email", LAKSHIT_EMAIL).eq("company_id", DEV).single();
  const lakshit = prof!.id as string;
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: LAKSHIT_EMAIL });
  const { data: v } = await anon.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "email" });
  token = v.session!.access_token;

  // SEED_ONLY=4,5,pool re-runs just those parts.
  const only = new Set((process.env.SEED_ONLY ?? "1,2,3,4,5,pool").split(","));
  if (only.has("1")) {
  console.log("1 · Ready to send");
  const c1 = await createCampaign("[TEST] 1 · Ready to send", await makeLeads(12, lakshit));
  await draftAndWait(c1, "c1");
  await api("/api/v1/drafts/bulk-approve", "POST", { draft_ids: (await draftIds(c1, 4)).map((d) => d.draft) });

  }
  if (only.has("2")) {
  console.log("2 · AI failures (3 leads always get a broken answer)");
  const c2 = await createCampaign("[TEST] 2 · AI failures", await makeLeads(10, lakshit, { failEvery: 4 }));
  await draftAndWait(c2, "c2");

  }
  if (only.has("3")) {
  console.log("3 · Credits run out halfway");
  const c3 = await createCampaign("[TEST] 3 · credits-run-out", await makeLeads(20, lakshit));
  await draftAndWait(c3, "c3");

  }
  if (only.has("4")) {
  console.log("4 · Partly sent");
  const c4 = await createCampaign("[TEST] 4 · Partly sent", await makeLeads(10, lakshit));
  await draftAndWait(c4, "c4");
  const toSend = await draftIds(c4, 5);
  await api("/api/v1/drafts/bulk-approve", "POST", { draft_ids: toSend.map((d) => d.draft) });
  await api(`/api/v1/campaigns/${c4}/send`, "POST", { campaign_lead_ids: toSend.map((d) => d.cl) });

  }
  if (only.has("5")) {
  console.log("5 · Still writing (slow fake AI; the last 30 start when the campaign is opened)");
  const c5 = await createCampaign("[TEST] 5 · slow writing", await makeLeads(6, lakshit));
  await draftAndWait(c5, "c5");
  await api("/api/v1/drafts/bulk-approve", "POST", { draft_ids: (await draftIds(c5, 6)).map((d) => d.draft) });
  await api(`/api/v1/campaigns/${c5}/leads`, "POST", { lead_ids: await makeLeads(30, lakshit) });

  }
  if (only.has("pool")) {
  console.log("Pool: 15 fake leads in no campaign, for creating one by hand");
  await makeLeads(15, lakshit);
  }
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
