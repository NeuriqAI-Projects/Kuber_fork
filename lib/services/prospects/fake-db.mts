// Test-only: just enough of the supabase-js query builder for the prospect
// tests. Tables are plain arrays; `fail` makes a write on a table error out.
type Row = Record<string, unknown>;

export function fakeDb(opts: { fail?: Partial<Record<string, "insert" | "upsert">>; unique?: Record<string, string> } = {}) {
  // Any table name reads as an (initially empty) array.
  const tables = new Proxy({} as Record<string, Row[]>, { get: (o, k: string) => (o[k] ??= []) });
  let n = 0;
  const from = (table: string) => {
    const t = tables[table];
    let op = "select", val: unknown, single = false, maybe = false, countHead = false;
    const filters: ((r: Row) => boolean)[] = [];
    const run = () => {
      if (op === "insert" || op === "upsert") {
        if (opts.fail?.[table] === op) return { data: null, error: { message: `${op} failed (fake)` } };
        const key = opts.unique?.[table] ?? "apollo_org_id";
        const rows = (Array.isArray(val) ? val : [val]) as Row[];
        const dup = (r: Row) => r[key] != null && t.some((x) => x[key] === r[key]);
        if (op === "insert" && rows.some(dup)) return { data: null, error: { message: "duplicate key (fake 23505)" } };
        const added = rows.filter((r) => !dup(r)).map((r) => ({ id: `id${++n}`, ...r }));
        t.push(...added);
        return { data: single ? added[0] ?? null : added, error: null };
      }
      const hit = t.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { hit.forEach((r) => Object.assign(r, val)); return { data: hit, error: null }; }
      if (countHead) return { data: null, count: hit.length, error: null };
      if (single || maybe) return { data: hit[0] ?? null, error: single && !hit[0] ? { message: "no rows" } : null };
      return { data: hit, error: null };
    };
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      insert: (v: unknown) => { op = "insert"; val = v; return q; },
      update: (v: unknown) => { op = "update"; val = v; return q; },
      upsert: (v: unknown) => { op = "upsert"; val = v; return q; },
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => { if (o?.head) countHead = true; return q; },
      single: () => { single = true; return q; },
      maybeSingle: () => { maybe = true; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      order: () => q, limit: () => q, // ponytail: no sorting, tests hold one matching row
      or: () => q, // ponytail: ignored, tests never hold a live lock
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(run()).then(res, rej),
    });
    return q;
  };
  // claim_prospect_page: last_page + 1 per filter key in prospect_page_memory, like the real one.
  const rpc = async (_fn: string, a: { p_key: string }) => {
    const mem = tables.prospect_page_memory;
    const row = mem.find((r) => r.filter_key === a.p_key) ?? (mem.push({ filter_key: a.p_key, last_page: 0 }), mem[mem.length - 1]);
    row.last_page = (row.last_page as number) + 1;
    return { data: row.last_page, error: null };
  };
  return { db: { from, rpc } as never, tables };
}
