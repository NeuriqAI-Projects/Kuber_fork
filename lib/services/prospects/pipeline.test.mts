// npx tsx --test lib/services/prospects/pipeline.test.mts
// Mock scenarios for the company-first pipeline: every outside service is a
// fake that can be told to fail, and the store is in memory. Zero spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, runBatch, WORKABLE, MAX_ATTEMPTS, type Deps, type ProspectRow, type ProspectPatch, type Store } from "./pipeline.ts";
import { DEFAULT_FIT_SCORING, parseFitScoring } from "./fit-rules.ts";
import { parseJevResponse } from "./jev.ts";
import type { JevScore } from "./jev.ts";

const CFG = DEFAULT_FIT_SCORING;
const RICH = "We are a plastic film converter running blown film lines for food packaging. ".repeat(5);
const THIN = "Welcome";

// ── fakes ───────────────────────────────────────────────────────────────────
class MemStore implements Store {
  rows = new Map<string, ProspectRow & ProspectPatch & { locked_until: number | null }>();
  autoReveals = 0;
  constructor(public clock: { t: number }) {}
  add(r: Partial<ProspectRow> & { id: string }) {
    this.rows.set(r.id, { search_id: "s1", apollo_org_id: "ap-" + r.id, name: "Co " + r.id, domain: null, website_url: null, linkedin_url: null,
      twitter_url: null, facebook_url: null, status: "queued", page_text: null, page_markdown: null, text_source: null, attempts: 0, locked_until: null, ...r });
  }
  async claim(limit: number) {
    const out: ProspectRow[] = [];
    for (const r of this.rows.values()) {
      if (out.length >= limit) break;
      if (!WORKABLE.includes(r.status) || (r.locked_until !== null && r.locked_until > this.clock.t)) continue;
      r.locked_until = this.clock.t + 5 * 60_000; // lock
      out.push({ ...r });
    }
    return out;
  }
  async save(id: string, p: ProspectPatch) {
    const r = this.rows.get(id)!;
    if (p.status === "good" && p.auto_reveal) this.autoReveals++;
    Object.assign(r, p, { locked_until: p.retry_at ?? null });
  }
  async countAutoReveals() { return this.autoReveals; }
  get(id: string) { return this.rows.get(id)!; }
}

const jev = (score: number): JevScore => ({ score, confidence: 0.9, reason: "converter · film · food · size medium", model: "fake", input_tokens: 100, answers: {} });

function makeDeps(clock: { t: number }, over: Partial<Deps> = {}) {
  const calls = { readHome: 0, score: 0, tavilySearch: 0, tavilyExtract: 0, findPeople: 0, promote: 0, freeGet: 0 };
  const promoted = new Map<string, string>(); // apollo_org_id -> org id (idempotent)
  const deps: Deps = {
    now: () => clock.t,
    readHome: async () => { calls.readHome++; return { kind: "ok", markdown: RICH }; },
    freeGet: async () => { calls.freeGet++; return null; },
    tavilyExtract: async () => { calls.tavilyExtract++; return RICH; },
    tavilySearch: async () => { calls.tavilySearch++; return ""; },
    score: async () => { calls.score++; return jev(9); },
    apolloCreditsFree: async () => 50,
    findPeople: async () => { calls.findPeople++; return [{ id: "p1", title: "Purchase Manager", has_email: true }, { id: "p2", title: "Intern", has_email: true }]; },
    promote: async (row: ProspectRow) => {
      calls.promote++;
      if (!promoted.has(row.apollo_org_id)) promoted.set(row.apollo_org_id, "org-" + row.id);
      return promoted.get(row.apollo_org_id)!;
    },
    ...over,
  };
  return { deps, calls, promoted };
}

async function drain(store: MemStore, deps: Deps, clock: { t: number }) {
  for (let i = 0; i < 20; i++) {
    await runBatch(deps, store, CFG, { budgetMs: 60_000, batch: 10 });
    clock.t += 15 * 60_000; // let backoffs and credit waits pass
  }
}

// ── scenarios ───────────────────────────────────────────────────────────────
test("1. happy path: website → score 9 → one contact promoted, Firecrawl paid once", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps, calls } = makeDeps(clock);
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  const r = store.get("a");
  assert.equal(r.status, "promoted");
  assert.equal(r.contact_apollo_id, "p1"); // the buyer, not the intern
  assert.equal(r.organization_id, "org-a");
  assert.equal(calls.readHome, 1);
  assert.equal(calls.promote, 1);
});

test("2. scores sort into buckets: 7+ good, 4–6 review, 1–3 hidden", async () => {
  for (const [score, want] of [[8, "promoted"], [5, "review"], [2, "hidden"]] as const) {
    const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock, { score: async () => jev(score) });
    store.add({ id: "x", website_url: "https://x.com" });
    await drain(store, deps, clock);
    assert.equal(store.get("x").status, want, `score ${score}`);
  }
});

test("3. 2–3 Apollo credits: search done, scoring done, reveal waits for credits — then resumes after top-up", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  let free = 0;
  const { deps, calls } = makeDeps(clock, { apolloCreditsFree: async () => free });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "waiting_credits");
  assert.equal(store.get("a").attempts, 0, "waiting for credits must not burn retries");
  assert.equal(calls.promote, 0, "no lead created without a credit for it");
  assert.equal(calls.readHome, 1, "website not re-read while waiting");
  free = 5; // top-up
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "promoted");
});

test("4. Apollo people search times out: retried with backoff, then succeeds", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  let fails = 2;
  const { deps } = makeDeps(clock, { findPeople: async () => { if (fails-- > 0) throw new Error("Apollo timeout"); return [{ id: "p1", title: "Owner", has_email: true }]; } });
  store.add({ id: "a", status: "good", page_text: RICH, text_source: "website" });
  await advance((await store.claim(1))[0], deps, store, CFG);
  assert.equal(store.get("a").status, "good"); assert.equal(store.get("a").attempts, 1);
  assert.ok(store.get("a").locked_until! > clock.t, "backed off");
  assert.equal((await store.claim(1)).length, 0, "not retried before the backoff");
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "promoted");
});

test("5. a step that keeps failing stops after 3 tries and goes to Review with the reason", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps } = makeDeps(clock, { score: async () => { throw new Error("JEV_HTTP_503"); } });
  store.add({ id: "a", status: "read", page_text: RICH, text_source: "website" });
  await drain(store, deps, clock);
  const r = store.get("a");
  assert.equal(r.status, "review"); assert.equal(r.attempts, MAX_ATTEMPTS);
  assert.match(r.last_error!, /3 tries: JEV_HTTP_503/);
});

test("6. Jev returns garbage: treated as a failure, never stored as a score", () => {
  assert.throws(() => parseJevResponse({ answers: { fit: { score: 42 } } }), /JEV_BAD_RESPONSE/);
  assert.throws(() => parseJevResponse({}), /JEV_BAD_RESPONSE/);
  assert.equal(parseJevResponse({ answers: { fit: { score: 8, confidence: 0.7 }, business: { choice: "converter" } } }).score, 9);
});

test("7. Firecrawl itself down (our side): retried, never marked as site down", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  let fails = 1;
  const { deps } = makeDeps(clock, { readHome: async () => { if (fails-- > 0) throw new Error("Firecrawl 402 out of credits"); return { kind: "ok", markdown: RICH }; } });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "promoted");
});

test("8. website down + LinkedIn given: LinkedIn is read; website not paid for twice", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps, calls } = makeDeps(clock, { readHome: async () => { calls.readHome++; return { kind: "site_down", detail: "HTTP 503" }; } });
  store.add({ id: "a", website_url: "https://a.com", linkedin_url: "https://linkedin.com/company/a" });
  await drain(store, deps, clock);
  const r = store.get("a");
  assert.equal(r.text_source, "linkedin"); assert.equal(r.status, "promoted");
  assert.equal(calls.readHome, 1);
});

test("9. website down, no social page: site_down for the client to decide", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps } = makeDeps(clock, { readHome: async () => ({ kind: "site_down", detail: "DNS failure" }) });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "site_down"); assert.match(store.get("a").last_error!, /DNS/);
});

test("10. no website, no LinkedIn: flagged without spending anything", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps, calls } = makeDeps(clock);
  store.add({ id: "a" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "flagged");
  assert.equal(calls.readHome + calls.tavilyExtract + calls.score, 0);
});

test("11. LinkedIn only, AI unsure: flagged (not auto-revealed, not review)", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock, { score: async () => jev(5) });
  store.add({ id: "a", linkedin_url: "https://linkedin.com/company/a" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "flagged");
});

test("12. LinkedIn page too thin: flagged", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock, { tavilyExtract: async () => THIN });
  store.add({ id: "a", linkedin_url: "https://linkedin.com/company/a" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "flagged");
});

test("13. unsure on website: free About page, then Tavily search, each re-scored", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const seq = [5, 5, 8];
  const { deps, calls } = makeDeps(clock, {
    score: async () => jev(seq.shift()!),
    freeGet: async (u: string) => (u.endsWith("/sitemap.xml") ? "<loc>https://a.com/about-us</loc>" : u.includes("about") ? `<p>${RICH}</p>` : null),
    tavilySearch: async () => { calls.tavilySearch++; return RICH; },
  });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  const r = store.get("a");
  assert.deepEqual(r.extra_sources, ["https://a.com/about-us", "tavily_search"]);
  assert.equal(r.score, 8); assert.equal(r.status, "promoted");
});

test("14. Tavily out of credits during the extra search: ignored, company still scored", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps } = makeDeps(clock, { score: async () => jev(5), tavilySearch: async () => { throw new Error("TAVILY_HTTP_432"); } });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "review"); assert.equal(store.get("a").attempts, 0);
});

test("15. worker killed after promote but before save (Vercel timeout): re-run creates no second lead", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps, promoted } = makeDeps(clock);
  store.add({ id: "a", status: "good", page_text: RICH, text_source: "website" });
  const row = (await store.claim(1))[0];
  await deps.promote(row, { id: "p1", title: "Owner", has_email: true }); // the call happened…
  // …and the process died: no save. The lock expires after 5 minutes.
  clock.t += 6 * 60_000;
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "promoted");
  assert.equal(promoted.size, 1, "promote is idempotent: still one org, one lead");
});

test("16. two workers at once never take the same company", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  for (const id of ["a", "b", "c"]) store.add({ id, website_url: `https://${id}.com` });
  const [w1, w2] = await Promise.all([store.claim(2), store.claim(2)]);
  const ids = [...w1, ...w2].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("17. auto-reveal cap per search: extras go to Review instead of spending", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps, calls } = makeDeps(clock);
  const cfg = { ...CFG, max_auto_reveals_per_search: 2 };
  for (const id of ["a", "b", "c"]) store.add({ id, website_url: `https://${id}.com` });
  for (let i = 0; i < 10; i++) { await runBatch(deps, store, cfg, { budgetMs: 60_000, batch: 10 }); clock.t += 15 * 60_000; }
  const statuses = ["a", "b", "c"].map((id) => store.get(id).status).sort();
  assert.deepEqual(statuses, ["promoted", "promoted", "review"]);
  assert.equal(calls.promote, 2);
});

test("18. good company with nobody emailable: no_contact, nothing created", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps, calls } = makeDeps(clock, { findPeople: async () => [{ id: "p", title: "CEO", has_email: false }] });
  store.add({ id: "a", status: "good", page_text: RICH, text_source: "website" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "no_contact"); assert.equal(calls.promote, 0);
});

test("19. client-approved Review company goes through the same reveal path", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock);
  store.add({ id: "a", status: "approved", page_text: RICH, text_source: "website" });
  await drain(store, deps, clock);
  assert.equal(store.get("a").status, "promoted");
});

test("20. time budget: no new step starts once the run's time is up (a step already running may finish)", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const starts: number[] = [];
  const { deps } = makeDeps(clock, { readHome: async () => { starts.push(clock.t); clock.t += 20_000; return { kind: "ok", markdown: RICH }; } });
  for (const id of ["a", "b", "c", "d", "e", "f"]) store.add({ id, website_url: `https://${id}.com` });
  await runBatch(deps, store, CFG, { budgetMs: 25_000, batch: 1 });
  assert.ok(starts.every((t) => t < 25_000), `started at ${starts}`);
  assert.ok(starts.length < 6, "the rest waits for the next run");
  const untouched = [...store.rows.values()].filter((r) => r.status === "queued" && r.locked_until === null);
  assert.ok(untouched.length > 0, "unstarted rows are not left locked");
});

test("21. fit settings: bad or partial client settings fall back to defaults", () => {
  assert.deepEqual(parseFitScoring("not json"), DEFAULT_FIT_SCORING);
  const p = parseFitScoring({ auto_reveal_min: 8, levels: ["too", "short"] });
  assert.equal(p.auto_reveal_min, 8); assert.equal(p.levels.length, 10);
});
