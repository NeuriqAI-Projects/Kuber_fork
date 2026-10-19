/**
 * Tiny stale-while-revalidate cache for client GETs (no SWR / react-query on
 * purpose — no new dependencies). Pure module, no React: `lib/api-client.ts`
 * wraps it in the `useCached` hook and the `prefetch*` helpers.
 *
 * - Keys are the request path (`/api/v1/campaigns`, `/api/v1/leads/<id>`…), so a
 *   mutation path tells us which keys it touched (see `invalidateForMutation`).
 * - Cached data is returned instantly; a revalidation runs in the background.
 * - Concurrent fetches of the same key share one promise.
 * - Everything is dropped when the signed-in user changes (`setScope`). A fetch
 *   that started under the previous user never writes into the new user's cache.
 *
 * Browser-only in practice: the server never calls `fetch`/`set` (they run from
 * effects and handlers), so the module-level instance cannot leak across requests.
 */

export type CacheEntry<T = unknown> = {
  data: T | undefined;
  error: unknown;
  /** ms timestamp of the last successful write; 0 = never. */
  updatedAt: number;
  /** Marked by invalidate(): the next read revalidates even inside the dedupe window. */
  stale: boolean;
  /** True while a fetch for this key is running. */
  validating: boolean;
};

type Fetcher<T> = () => Promise<T>;

/** Which cached resources a write to `/api/v1/<resource>/…` can change. Those
 *  entries go stale; the mounted ones refetch right away. Kept narrow on
 *  purpose — refetching everything on screen after each draft approval would
 *  be a request storm on the campaign page. */
const RELATED: Record<string, string[]> = {
  leads:            ["leads", "organizations", "campaigns", "dashboard", "imports", "unibox"],
  organizations:    ["organizations", "leads"],
  campaigns:        ["campaigns", "dashboard", "leads"],
  "campaign-leads": ["campaigns", "leads", "dashboard"],
  drafts:           ["drafts"],
  "reply-drafts":   ["reply-drafts", "campaigns", "unibox", "dashboard"],
  unibox:           ["unibox", "campaigns", "leads"],
  imports:          ["imports", "leads"],
  prospects:        ["prospects", "organizations", "leads"],
  settings:         ["settings"],
  me:               ["me", "settings"],
  "user-signature": ["user-signature"],
  "model-lab":      ["model-lab"],
};

/** `/api/v1/campaigns/abc/pause?x=1` → `campaigns`. */
export function resourceOf(path: string): string {
  const clean = path.split("?")[0];
  const m = clean.match(/^\/api\/v1\/([^/]+)/);
  return m ? m[1] : clean;
}

export class QueryCache {
  private entries = new Map<string, CacheEntry>();
  private listeners = new Map<string, Set<() => void>>();
  private fetchers = new Map<string, Fetcher<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private scope: string | null = null;
  private generation = 0;
  now: () => number = () => Date.now();

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  getData<T>(key: string): T | undefined {
    return this.get<T>(key)?.data;
  }

  /** Change the cache owner (the signed-in user id, or null when signed out).
   *  A different owner drops every entry. Returns true when it changed. */
  setScope(scope: string | null): boolean {
    if (scope === this.scope) return false;
    this.scope = scope;
    this.reset(false);
    return true;
  }

  /** Drop everything (sign-out, 401). */
  clear(): void {
    this.reset(true);
  }

  private reset(notify: boolean) {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
    this.fetchers.clear();
    if (notify) for (const key of this.listeners.keys()) this.emit(key);
  }

  /** Remember how to (re)load a key so invalidate()/prefetch can refetch it. */
  setFetcher<T>(key: string, fetcher: Fetcher<T>): void {
    this.fetchers.set(key, fetcher as Fetcher<unknown>);
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) { set = new Set(); this.listeners.set(key, set); }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.listeners.delete(key);
    };
  }

  hasSubscribers(key: string): boolean {
    return (this.listeners.get(key)?.size ?? 0) > 0;
  }

  private emit(key: string) {
    for (const cb of this.listeners.get(key) ?? []) cb();
  }

  private write(key: string, patch: Partial<CacheEntry>) {
    const prev = this.entries.get(key) ?? { data: undefined, error: null, updatedAt: 0, stale: false, validating: false };
    // New object every time: useSyncExternalStore compares snapshots by identity.
    this.entries.set(key, { ...prev, ...patch });
    this.emit(key);
  }

  /** Is the cached value young enough to skip a revalidation? */
  isFresh(key: string, maxAgeMs: number): boolean {
    const e = this.entries.get(key);
    return !!e && e.data !== undefined && !e.stale && this.now() - e.updatedAt < maxAgeMs;
  }

  /**
   * Load `key`. Returns the cached value without a request when it is younger
   * than `maxAgeMs` (default 0 = always fetch); joins a running fetch for the
   * same key instead of starting a second one.
   */
  fetch<T>(key: string, fetcher?: Fetcher<T>, opts: { maxAgeMs?: number } = {}): Promise<T> {
    if (fetcher) this.setFetcher(key, fetcher);
    const run = (fetcher ?? this.fetchers.get(key)) as Fetcher<T> | undefined;
    if (!run) return Promise.reject(new Error(`No fetcher registered for ${key}`));
    if (opts.maxAgeMs && this.isFresh(key, opts.maxAgeMs)) return Promise.resolve(this.getData<T>(key) as T);
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const gen = this.generation;
    // Started on a microtask so even a fetcher that throws synchronously goes
    // through the same settle path (and `p` exists by the time it settles).
    const p: Promise<T> = Promise.resolve().then(run).then(
      (data) => {
        if (gen === this.generation) {
          if (this.inflight.get(key) === p) this.inflight.delete(key);
          this.write(key, { data, error: null, updatedAt: this.now(), stale: false, validating: false });
        }
        return data;
      },
      (err) => {
        if (gen === this.generation) {
          if (this.inflight.get(key) === p) this.inflight.delete(key);
          this.write(key, { error: err, validating: false });
        }
        throw err;
      },
    );
    this.inflight.set(key, p);
    this.write(key, { validating: true });
    return p;
  }

  /** Overwrite (or update from the previous value) without a request — for
   *  optimistic updates and for seeding a detail key from a list row. */
  set<T>(key: string, next: T | ((prev: T | undefined) => T)): void {
    const prev = this.getData<T>(key);
    const data = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
    this.write(key, { data, error: null, updatedAt: this.now(), stale: false });
  }

  /** Seed a key only if nothing is cached yet (never clobbers fresher data). */
  seed<T>(key: string, data: T): void {
    if (this.getData(key) !== undefined) return;
    this.write(key, { data, error: null, updatedAt: 0, stale: true });
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Mark matching keys stale; refetch the ones currently on screen (subscribed
   * and with a known fetcher). `match` is a key prefix or a predicate.
   */
  invalidate(match: string | ((key: string) => boolean), opts: { refetch?: boolean } = {}): void {
    const test = typeof match === "string" ? (k: string) => k.startsWith(match) : match;
    const refetch = opts.refetch ?? true;
    for (const key of this.keys()) {
      if (!test(key)) continue;
      this.write(key, { stale: true });
      if (refetch && this.hasSubscribers(key) && this.fetchers.has(key)) {
        void this.fetch(key).catch(() => {});
      }
    }
  }

  /** After a successful POST/PATCH/PUT/DELETE to `path`: entries of related
   *  resources go stale (revalidated on their next read) and the mounted ones
   *  refetch now. Unrelated entries are left alone. */
  invalidateForMutation(path: string): void {
    const resource = resourceOf(path);
    const related = new Set(RELATED[resource] ?? [resource]);
    this.invalidate((key) => related.has(resourceOf(key)));
  }
}

/** The app-wide instance. */
export const queryCache = new QueryCache();

// Dev-only handle for inspecting the cache from the browser console.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __queryCache?: QueryCache }).__queryCache = queryCache;
}
