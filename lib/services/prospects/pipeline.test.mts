// npx tsx --test lib/services/prospects/pipeline.test.mts
// Mock scenarios for the company-first pipeline: every outside service is a
// fake that can be told to fail, and the store is in memory. Zero spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, runBatch, OutOfTime, WORKABLE, MAX_ATTEMPTS, type Deps, type ProspectRow, type ProspectPatch, type Store } from "./pipeline.ts";
import { DEFAULT_FIT_SCORING, parseFitScoring } from "./fit-rules.ts";
import { parseJevResponse } from "./jev.ts";
import type { JevVerdict } from "./jev.ts";
import { limiter } from "./deps.ts";

const CFG = DEFAULT_FIT_SCORING;
const RICH = "We are a plastic film converter running blown film lines for food packaging. ".repeat(5);
const THIN = "Welcome";

// ── fakes ───────────────────────────────────────────────────────────────────
class MemStore implements Store {
  rows = new Map<string, ProspectRow & ProspectPatch & { locked_until: number | null }>();
  autoRevealCount = 0;
  capOverride: number | null = null;
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
    Object.assign(r, p, { locked_until: p.retry_at ?? null });
  }
  // Synchronous check-and-take = atomic in JS, like the SQL function.
  async reserveAutoReveal(_s: string, defaultCap: number) {
    if (this.autoRevealCount >= (this.capOverride ?? defaultCap)) return false;
    this.autoRevealCount++; return true;
  }
  get(id: string) { return this.rows.get(id)!; }
}

/** Jev's two answers: P(plastic maker) and P(makes the searched products). */
const jev = (plastic: number, on_target = 0.9): JevVerdict => ({ plastic, on_target, model: "fake", input_tokens: 100, answers: {} });

function makeDeps(clock: { t: number }, over: Partial<Deps> = {}) {
  const calls = { readHome: 0, score: 0, tavilySearch: 0, tavilyExtract: 0, findPeople: 0, promote: 0, freeGet: 0 };
  const promoted = new Map<string, string>(); // apollo_org_id -> org id (idempotent)
  const deps: Deps = {
    now: () => clock.t,
    readHome: async () => { calls.readHome++; return { kind: "ok", markdown: RICH }; },
    freeGet: async () => { calls.freeGet++; return null; },
    tavilyExtract: async () => { calls.tavilyExtract++; return RICH; },
    tavilySearch: async () => { calls.tavilySearch++; return ""; },
    score: async () => { calls.score++; return jev(0.9); },
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
    await runBatch(deps, store, CFG, { budgetMs: 60_000, lanes: 4 });
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

test("2. Jev's answer decides: plastic maker → good, not → hidden, in between → your decision", async () => {
  for (const [score, want] of [[0.9, "promoted"], [0.5, "review"], [0.1, "hidden"]] as const) {
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
  assert.throws(() => parseJevResponse({ answers: { plastic_maker: { noul: 1.4 }, on_target: { noul: 0.2 } } }), /JEV_BAD_RESPONSE/);
  assert.throws(() => parseJevResponse({ answers: { plastic_maker: { noul: 0.9 } } }), /JEV_BAD_RESPONSE/);
  assert.throws(() => parseJevResponse({}), /JEV_BAD_RESPONSE/);
  assert.equal(parseJevResponse({ answers: { plastic_maker: { noul: 0.91 }, on_target: { noul: 0.2 } }, usage: { input_tokens: 1900 } }).plastic, 0.91);
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
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock, { score: async () => jev(0.5) });
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
  const seq = [0.5, 0.5, 0.9];
  const { deps, calls } = makeDeps(clock, {
    score: async () => jev(seq.shift()!),
    freeGet: async (u: string) => (u.endsWith("/sitemap.xml") ? "<loc>https://a.com/about-us</loc>" : u.includes("about") ? `<p>${RICH}</p>` : null),
    tavilySearch: async () => { calls.tavilySearch++; return RICH; },
  });
  store.add({ id: "a", website_url: "https://a.com" });
  await drain(store, deps, clock);
  const r = store.get("a");
  assert.deepEqual(r.extra_sources, ["https://a.com/about-us", "tavily_search"]);
  assert.equal(r.score, 9); assert.equal(r.status, "promoted");
});

test("14. Tavily out of credits during the extra search: ignored, company still scored", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  const { deps } = makeDeps(clock, { score: async () => jev(0.5), tavilySearch: async () => { throw new Error("TAVILY_HTTP_432"); } });
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
  for (let i = 0; i < 10; i++) { await runBatch(deps, store, cfg, { budgetMs: 60_000, lanes: 4 }); clock.t += 15 * 60_000; }
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
  await runBatch(deps, store, CFG, { budgetMs: 25_000, lanes: 1 });
  assert.ok(starts.every((t) => t < 25_000), `started at ${starts}`);
  assert.ok(starts.length < 6, "the rest waits for the next run");
  const untouched = [...store.rows.values()].filter((r) => r.status === "queued" && r.locked_until === null);
  assert.ok(untouched.length > 0, "unstarted rows are not left locked");
});

test("21. fit settings: bad or partial client settings fall back to defaults", () => {
  assert.deepEqual(parseFitScoring("not json"), DEFAULT_FIT_SCORING);
  assert.equal(parseFitScoring({ yes_min: 0.7 }).yes_min, 0.7);
  assert.deepEqual(parseFitScoring({ yes_min: 0.2, no_max: 0.5 }), DEFAULT_FIT_SCORING, "yes below no is rejected");
});

test("22. a search's own reveal limit wins over the company setting", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock); const { deps, calls } = makeDeps(clock);
  store.capOverride = 1;
  for (const id of ["a", "b"]) store.add({ id, website_url: `https://${id}.com` });
  await drain(store, deps, clock);
  assert.deepEqual(["a", "b"].map((id) => store.get(id).status).sort(), ["promoted", "review"]);
  assert.equal(calls.promote, 1);
});

test("23. score shows priority: 9 = makes the searched products, 7 = other plastic products", async () => {
  for (const [on, want] of [[0.9, 9], [0.2, 7]] as const) {
    const clock = { t: 0 }; const store = new MemStore(clock); const { deps } = makeDeps(clock, { score: async () => jev(0.9, on) });
    store.add({ id: "a", website_url: "https://a.com" });
    await drain(store, deps, clock);
    assert.equal(store.get("a").score, want);
    assert.equal(store.get("a").status, "promoted", "both are plastic makers, so both are revealed");
  }
});

test("24. parallel lanes: many companies at once, never more than 4 Firecrawl reads at once", async () => {
  // Real timers here: this measures actual concurrency, not a fake clock.
  const store = new MemStore({ t: 0 });
  const slot = limiter(4);
  let reading = 0, peak = 0;
  const deps = makeDeps({ t: 0 }, {
    now: () => Date.now(),
    readHome: (url: string) => slot(async () => {
      reading++; peak = Math.max(peak, reading);
      await new Promise((r) => setTimeout(r, 40));
      reading--;
      return { kind: "ok" as const, markdown: RICH + url };
    }),
    score: async () => { await new Promise((r) => setTimeout(r, 5)); return jev(0.1); },
  }).deps;
  store.clock = { get t() { return Date.now(); } } as { t: number };
  for (let i = 0; i < 24; i++) store.add({ id: `c${i}`, website_url: `https://c${i}.com` });
  const t0 = Date.now();
  await runBatch(deps, store, CFG, { budgetMs: 30_000, lanes: 8 });
  const ms = Date.now() - t0;
  assert.equal(peak, 4, "Firecrawl capped at 4 at once");
  assert.ok([...store.rows.values()].every((r) => r.status === "hidden"), "all 24 finished in one run");
  assert.ok(ms < 24 * 40 * 0.5, `parallel run took ${ms} ms (one at a time would be ~${24 * 40} ms)`);
});

test("25. no paid read starts once the run is nearly over: the company waits for the next run, no try used", async () => {
  const clock = { t: 0 }; const store = new MemStore(clock);
  let paid = 0;
  const { deps } = makeDeps(clock, { readHome: async (_u: string, startBy: number) => { if (clock.t > startBy) throw new OutOfTime(); paid++; return { kind: "ok", markdown: RICH }; } });
  store.add({ id: "a", website_url: "https://a.com" });
  const row = (await store.claim(1))[0];
  clock.t = 40_000;
  await advance(row, deps, store, CFG, 35_000);
  assert.equal(paid, 0, "Firecrawl not called");
  const r = store.get("a");
  assert.equal(r.status, "queued"); assert.equal(r.attempts, 0); assert.equal(r.locked_until, null, "released for the next run");
});
