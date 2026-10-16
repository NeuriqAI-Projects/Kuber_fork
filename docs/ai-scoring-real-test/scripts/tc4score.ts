// TC-6: score real companies with the REAL services (Firecrawl, Jev, Tavily) and an in-memory store.
// Nothing is written to the database. 0 Apollo credits. ~1 Firecrawl credit per distinct company read.
import fs from "node:fs";
import { CLIENT, OUT, ledger, sleep, services } from "./lib";

const PER_KEYWORD = 5;
const FIRECRAWL_HARD_STOP = 390;
const POS = [0, 19, 39, 59, 79];

(async () => {
  const { realDeps } = await import("../../../lib/services/prospects/deps");
  const { runBatch } = await import("../../../lib/services/prospects/pipeline");
  const { DEFAULT_FIT_SCORING } = await import("../../../lib/services/prospects/fit-rules");
  const { jevCheck } = await import("../../../lib/services/prospects/jev");
  const { getServiceSecret } = await import("../../../lib/services/service-keys");
  type Row = import("../../../lib/services/prospects/pipeline").ProspectRow;

  const { admin, firecrawlBalance } = await services();
  const kws = JSON.parse(fs.readFileSync(OUT + "keywords.json", "utf8")) as { id: string; word: string; labels: string[]; groups: string[] }[];
  fs.mkdirSync(OUT + "tc4", { recursive: true });

  // ---- sample: 8 NEW companies from each deeper page of "stretch film" (K01) ----
  const rows: (Row & Record<string, any>)[] = [];
  for (const pg of ["p2", "p5", "p10"]) {
    const d = JSON.parse(fs.readFileSync(OUT + `tc45/K01-${pg}.json`, "utf8"));
    const fresh = d.orgs.filter((o: any) => !o.known);
    const step = Math.max(1, Math.floor(fresh.length / 8));
    const pick = Array.from({ length: Math.min(8, fresh.length) }, (_, i) => fresh[Math.min(i * step, fresh.length - 1)]);
    for (const o of pick) rows.push({
      id: `K01-${pg}:${o.id}`, search_id: "K01", apollo_org_id: o.id, name: o.name ?? "Unknown", domain: o.primary_domain, website_url: o.website_url,
      linkedin_url: o.linkedin_url, twitter_url: o.twitter_url, facebook_url: o.facebook_url, status: "queued", page_text: null, page_markdown: null, text_source: null, attempts: 0,
      _lockUntil: 0, _log: [], _ms: 0, _t0: 0, _page: pg,
    } as any);
  }
  console.log("sample:", rows.length, "rows,", new Set(rows.map((r) => r.apollo_org_id)).size, "distinct companies");

  // ---- store (in memory) ----
  const TERMINAL = new Set(["good", "review", "hidden", "flagged", "site_down"]);
  const store = {
    async claim(limit: number) {
      const now = Date.now(); const out: any[] = [];
      for (const r of rows) { if (out.length >= limit) break; if (["queued", "read_social", "read"].includes(r.status) && !(r as any)._claimed && (r as any)._lockUntil <= now) { (r as any)._claimed = true; if (!(r as any)._t0) (r as any)._t0 = Date.now(); out.push({ ...r }); } }
      return out;
    },
    async save(id: string, patch: any) {
      const r = rows.find((x) => x.id === id)!; const { retry_at, ...rest } = patch;
      Object.assign(r, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      (r as any)._claimed = false; (r as any)._lockUntil = retry_at ?? 0;
      if (TERMINAL.has(r.status)) (r as any)._ms = Date.now() - (r as any)._t0;
    },
    async reserveAutoReveal() { return true; },
  };

  // ---- deps: real services, wrapped to count paid calls, cache page reads by URL and capture Jev answers ----
  const jevKey = (await getServiceSecret("jev", CLIENT))!;
  const real = realDeps(admin, CLIENT, async () => ({ importId: null, createdBy: null }));
  const pageCache = new Map<string, any>();
  const stats = { firecrawl_calls: 0, firecrawl_reused: 0, tavily_extract: 0, tavily_search: 0, jev_calls: 0, jev_tokens: 0, readMs: [] as number[], jevMs: [] as number[] };
  const rowOf = (r: Row) => rows.find((x) => x.id === r.id)!;
  const deps = {
    ...real,
    readHome: async (url: string, startBy: number, row: Row) => {
      if (pageCache.has(url)) { stats.firecrawl_reused++; rowOf(row)._log.push({ readHome: "reused" }); return pageCache.get(url); }
      const { firecrawl_calls } = stats;
      if (firecrawl_calls + 0 >= FIRECRAWL_HARD_STOP) throw new Error("FIRECRAWL HARD STOP");
      stats.firecrawl_calls++;
      const t = Date.now();
      try { const res = await real.readHome(url, startBy, row); pageCache.set(url, res); stats.readMs.push(Date.now() - t); rowOf(row)._log.push({ readHome: res.kind, ms: Date.now() - t }); return res; }
      catch (e) { rowOf(row)._log.push({ readHome: "error", err: (e as Error).message.slice(0, 120), ms: Date.now() - t }); throw e; }
    },
    tavilyExtract: async (url: string) => { stats.tavily_extract++; return real.tavilyExtract(url); },
    tavilySearch: async (q: string) => { stats.tavily_search++; return real.tavilySearch(q); },
    score: async (row: Row, text: string) => {
      const k = kws.find((x) => x.id === row.search_id)!;
      const t = Date.now(); stats.jev_calls++;
      const v = await jevCheck(jevKey, { name: row.name, website: row.domain }, { segment: k.groups.join(" / "), keywords: k.labels }, text);
      stats.jev_tokens += v.input_tokens; stats.jevMs.push(Date.now() - t);
      rowOf(row)._log.push({ jev: { plastic: v.plastic, on_target: v.on_target, tokens: v.input_tokens, ms: Date.now() - t, textLen: text.length } });
      return v;
    },
    apolloCreditsFree: async () => { throw new Error("TC-6 must never reveal"); },
    findPeople: async () => { throw new Error("TC-6 must never reveal"); },
    promote: async () => { throw new Error("TC-6 must never reveal"); },
  };

  const fcBefore = await firecrawlBalance();
  console.log("firecrawl balance before:", fcBefore);
  const started = Date.now();
  for (let run = 1; run <= 80; run++) {
    const pending = rows.filter((r) => !TERMINAL.has(r.status));
    if (!pending.length) break;
    const claimable = pending.filter((r) => (r as any)._lockUntil <= Date.now());
    if (!claimable.length) { console.log("waiting for retry backoff...", pending.length); await sleep(15000); if (Date.now() - started > 40 * 60_000) break; continue; }
    const res = await runBatch(deps as any, store as any, DEFAULT_FIT_SCORING, { budgetMs: 30_000, lanes: 8, paidStartMs: 35_000 });
    const left = rows.filter((r) => !TERMINAL.has(r.status)).length;
    console.log(`run ${run}: advanced ${res.advanced}, left ${left}, firecrawl calls ${stats.firecrawl_calls}`);
    fs.writeFileSync(OUT + "tc4-progress.json", JSON.stringify({ at: new Date().toISOString(), run, left, stats: { ...stats, readMs: undefined, jevMs: undefined } }));
  }
  const fcAfter = await firecrawlBalance();
  ledger("TC-4", "firecrawl", "scoring_run", `${rows.length} rows, ${stats.firecrawl_calls} reads, ${stats.firecrawl_reused} reused`, stats.firecrawl_calls, fcBefore, fcAfter);
  ledger("TC-4", "tavily", "calls", `extract=${stats.tavily_extract} search=${stats.tavily_search}`, stats.tavily_extract + stats.tavily_search, "", "");

  // ---- outputs ----
  const out = rows.map((r: any) => {
    const jevs = r._log.filter((l: any) => l.jev);
    const last = jevs[jevs.length - 1]?.jev;
    return {
      page: r._page, keyword_id: r.search_id, word: kws.find((k) => k.id === r.search_id)!.word, apollo_id: r.apollo_org_id, name: r.name, domain: r.domain,
      status: r.status, plastic: last?.plastic ?? null, on_target: last?.on_target ?? null, score: r.score ?? null, reason: r.reason ?? null,
      text_source: r.text_source, extra_sources: r.extra_sources ?? [], words: (r.page_text ?? "").split(/\s+/).filter(Boolean).length,
      jev_tokens: r.jev_tokens ?? 0, jev_calls: jevs.length, attempts: r.attempts, last_error: r.last_error ?? null, ms: r._ms, log: r._log,
      text_excerpt: (r.page_text ?? "").slice(0, 1500),
    };
  });
  fs.writeFileSync(OUT + "tc4-results.json", JSON.stringify({ finished: new Date().toISOString(), stats: { ...stats, readMs: undefined, jevMs: undefined, avg_read_ms: avg(stats.readMs), max_read_ms: Math.max(0, ...stats.readMs), avg_jev_ms: avg(stats.jevMs), jev_usd: stats.jev_tokens / 1e6 * 0.042, wall_seconds: Math.round((Date.now() - started) / 1000) }, rows: out }, null, 1));
  const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""').replace(/\s+/g, " ")}"`;
  fs.writeFileSync(OUT + "tc4-review-sheet.csv", "page,apollo_id,name,domain,text_source,text_excerpt\n" + out.filter((o) => o.text_excerpt).map((o) => [o.page, o.apollo_id, esc(o.name), o.domain, o.text_source, esc(o.text_excerpt)].join(",")).join("\n") + "\n");
  // full page text kept for the audit (not for git)
  fs.mkdirSync(OUT + "tc4/pages", { recursive: true });
  for (const r of rows as any[]) if (r.page_text) fs.writeFileSync(OUT + `tc4/pages/${r.apollo_org_id}.txt`, r.page_text);
  const by: Record<string, number> = {}; for (const o of out) by[o.status] = (by[o.status] ?? 0) + 1;
  console.log("done", JSON.stringify(by), "firecrawl", fcBefore, "->", fcAfter, "calls", stats.firecrawl_calls, "jev$", (stats.jev_tokens / 1e6 * 0.042).toFixed(4));
})().catch((e) => { console.error("FAILED", e?.message ?? e); process.exit(1); });
const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
