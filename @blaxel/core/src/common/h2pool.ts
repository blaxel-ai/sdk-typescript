import type http2 from "http2";
import { settings } from "./settings.js";

type EstablishFn = (hostname: string) => Promise<http2.ClientHttp2Session>;
type NowFn = () => number;
type MaxFn = () => number;

type H2PoolEntry = {
  session: http2.ClientHttp2Session;
  lastUsedAt: number;
};

/**
 * Per-domain state: up to `maxConnections` warm sessions, the in-flight
 * establishes that will become sessions, and a monotonic round-robin cursor.
 */
type DomainState = {
  entries: H2PoolEntry[];
  inflight: Set<Promise<http2.ClientHttp2Session | null>>;
  cursor: number;
};

export type H2PoolOptions = {
  maxIdleMs?: number;
  pingTimeoutMs?: number;
  now?: NowFn;
  /**
   * Number of warm sessions to keep per domain. A function is re-read on every
   * warm()/get() so the value can be driven by runtime config (the singleton
   * reads `settings.h2PoolSize`). Defaults to 1 (single-session, the historical
   * behavior) for directly-constructed pools.
   */
  maxConnections?: number | MaxFn;
};

const DEFAULT_MAX_IDLE_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 500;

/**
 * Singleton H2 session pool keyed by edge / control-plane domain.
 *
 * Each domain keeps up to `maxConnections` warm sessions and round-robins
 * requests across them, so a burst of concurrent creates/execs spreads over
 * several connections (and, with DNS fan-out in `establishH2`, several proxies)
 * instead of funnelling through one session capped by the server's
 * SETTINGS_MAX_CONCURRENT_STREAMS. With `maxConnections = 1` it behaves exactly
 * like the previous single-session pool.
 *
 * - `warm(domain)` fills the domain up to `maxConnections` in the background
 *   (fire-and-forget); safe to call repeatedly.
 * - `get(domain)` reuses a live warm session (round-robin), joins an in-flight
 *   warming, or establishes one on demand.
 * - `tryGet(domain)` is a non-blocking cache check (round-robin, no establish).
 * - Closed / GOAWAY'd sessions are evicted automatically.
 */
export class H2Pool {
  private domains = new Map<string, DomainState>();
  private _establish: EstablishFn | null = null;
  private readonly maxIdleMs: number;
  private readonly pingTimeoutMs: number;
  private readonly now: NowFn;
  private readonly maxConnections: MaxFn;
  // Guards against attaching eviction listeners to the same session twice
  // (e.g. if the same session object is handed back by establish()).
  private readonly listenerAttached = new WeakSet<http2.ClientHttp2Session>();

  constructor(options: H2PoolOptions = {}) {
    this.maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    const mc = options.maxConnections;
    this.maxConnections =
      typeof mc === "function" ? mc : () => (typeof mc === "number" ? mc : 1);
  }

  private resolveMax(): number {
    const n = Math.floor(this.maxConnections());
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  private state(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = { entries: [], inflight: new Set(), cursor: 0 };
      this.domains.set(domain, s);
    }
    return s;
  }

  /**
   * Lazily resolve the establish function so the http2 / tls / dns modules
   * are only imported in Node.js environments.
   */
  private async establish(domain: string): Promise<http2.ClientHttp2Session> {
    if (!this._establish) {
      const { establishH2 } = await import("./h2warm.js");
      this._establish = establishH2;
    }
    return this._establish(domain);
  }

  /**
   * Cache a session under `domain`, attaching self-healing eviction listeners
   * once so a session removes itself from the pool on `goaway`/`error`/`close`.
   * Idempotent for a session already cached (returns the existing entry).
   */
  private cache(domain: string, session: http2.ClientHttp2Session): H2PoolEntry {
    const s = this.state(domain);
    const existing = s.entries.find((e) => e.session === session);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing;
    }
    const entry: H2PoolEntry = { session, lastUsedAt: this.now() };
    s.entries.push(entry);
    this.attachEvictionListeners(domain, session);
    return entry;
  }

  private attachEvictionListeners(
    domain: string,
    session: http2.ClientHttp2Session,
  ): void {
    if (this.listenerAttached.has(session)) return;
    this.listenerAttached.add(session);
    const evict = () => this.removeSession(domain, session);
    session.on("goaway", evict);
    session.on("error", evict);
    session.on("close", evict);
  }

  private removeSession(
    domain: string,
    session: http2.ClientHttp2Session,
  ): void {
    const s = this.domains.get(domain);
    if (!s) return;
    const i = s.entries.findIndex((e) => e.session === session);
    if (i >= 0) s.entries.splice(i, 1);
  }

  private removeEntry(s: DomainState, entry: H2PoolEntry): void {
    const i = s.entries.indexOf(entry);
    if (i >= 0) s.entries.splice(i, 1);
  }

  private isClosed(session: http2.ClientHttp2Session): boolean {
    return session.closed || session.destroyed;
  }

  private isIdle(entry: H2PoolEntry): boolean {
    return this.now() - entry.lastUsedAt > this.maxIdleMs;
  }

  private markUsed(entry: H2PoolEntry): void {
    entry.lastUsedAt = this.now();
  }

  private ping(session: http2.ClientHttp2Session): Promise<boolean> {
    if (this.isClosed(session)) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), this.pingTimeoutMs);

      try {
        const sent = session.ping((err?: Error | null) => {
          finish(!err && !this.isClosed(session));
        });
        if (!sent) finish(false);
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Round-robin scan of a domain's cached sessions for a usable one. Closed
   * sessions are dropped; an idle session is ping-validated before use. Returns
   * `null` if the domain has no usable session.
   *
   * The generation/identity pin (ENG-2676): `ping` yields, and during that await
   * an eviction listener may have removed `entry` from the domain. We re-check
   * membership after the ping and refuse a session that is no longer cached, so
   * a zombie is never handed back (ENG-2422).
   */
  private async pickLiveEntry(
    s: DomainState,
  ): Promise<http2.ClientHttp2Session | null> {
    let attempts = s.entries.length;
    while (attempts-- > 0 && s.entries.length > 0) {
      const idx = s.cursor % s.entries.length;
      const entry = s.entries[idx];
      s.cursor = (s.cursor + 1) % Number.MAX_SAFE_INTEGER;
      if (!entry) continue;

      if (this.isClosed(entry.session)) {
        this.removeEntry(s, entry);
        // Splicing shifts the next element into `idx`; rewind so we don't skip
        // it (the advanced cursor would otherwise jump past it).
        if (s.entries.length > 0) s.cursor = idx;
        continue;
      }
      if (!this.isIdle(entry)) {
        this.markUsed(entry);
        return entry.session;
      }
      if (await this.ping(entry.session)) {
        if (!s.entries.includes(entry)) continue;
        this.markUsed(entry);
        return entry.session;
      }
      // Ping failed on an idle session: drop and close it so a fresh one is
      // opened in its place (the eviction 'close' listener is a no-op re-remove).
      this.removeEntry(s, entry);
      if (s.entries.length > 0) s.cursor = idx;
      if (!this.isClosed(entry.session)) entry.session.close();
    }
    return null;
  }

  /**
   * Kick off one background establish for `domain`, tracked in `inflight` so
   * concurrent callers dedupe against it and `warm()` respects the cap.
   */
  private startEstablish(
    domain: string,
    s: DomainState,
  ): Promise<http2.ClientHttp2Session | null> {
    const p = this.establish(domain)
      .then((session) => {
        if (session) this.cache(domain, session);
        return session;
      })
      .catch(() => null)
      .finally(() => {
        s.inflight.delete(p);
      });
    s.inflight.add(p);
    return p;
  }

  /**
   * Fire-and-forget background warming: opens sessions until the domain has
   * `maxConnections` live-or-in-flight. Safe to call repeatedly.
   */
  warm(domain: string): void {
    const max = this.resolveMax();
    const s = this.state(domain);
    // Drop closed sessions so warming refills them.
    for (let i = s.entries.length - 1; i >= 0; i--) {
      if (this.isClosed(s.entries[i].session)) s.entries.splice(i, 1);
    }
    while (s.entries.length + s.inflight.size < max) {
      void this.startEstablish(domain, s);
    }
  }

  /**
   * Synchronous cache check: round-robin over live, non-idle sessions. Never
   * blocks and never establishes. Returns `null` if none are immediately usable.
   */
  tryGet(domain: string): http2.ClientHttp2Session | null {
    const s = this.domains.get(domain);
    if (!s || s.entries.length === 0) return null;
    let attempts = s.entries.length;
    while (attempts-- > 0 && s.entries.length > 0) {
      const idx = s.cursor % s.entries.length;
      const entry = s.entries[idx];
      s.cursor = (s.cursor + 1) % Number.MAX_SAFE_INTEGER;
      if (this.isClosed(entry.session)) {
        this.removeEntry(s, entry);
        if (s.entries.length > 0) s.cursor = idx;
        continue;
      }
      if (this.isIdle(entry)) continue;
      this.markUsed(entry);
      return entry.session;
    }
    return null;
  }

  isUsable(session: http2.ClientHttp2Session): boolean {
    return !this.isClosed(session);
  }

  evictSession(domain: string, session: http2.ClientHttp2Session): void {
    this.removeSession(domain, session);
    if (!session.closed && !session.destroyed) session.close();
  }

  /**
   * Get a live H2 session for `domain`. Reuses a warm session (round-robin),
   * joins in-flight warming, or establishes one. When the pool is below
   * `maxConnections` it also tops up the remaining slots in the background so
   * repeated calls converge on a full, load-balanced pool.
   */
  async get(domain: string): Promise<http2.ClientHttp2Session | null> {
    const s = this.state(domain);
    const max = this.resolveMax();

    const fast = await this.pickLiveEntry(s);
    if (fast) {
      // Top up the rest of the pool in the background. warm() fills to the cap
      // in one call and re-checks `entries + inflight < max` before each
      // establish, so it converges quickly and never overshoots even when
      // several concurrent get()s take this path.
      if (max > 1 && s.entries.length + s.inflight.size < max) {
        this.warm(domain);
      }
      return fast;
    }

    // No usable cached session: join any in-flight warming, then re-pick.
    if (s.inflight.size > 0) {
      await Promise.allSettled([...s.inflight]);
      const afterWarm = await this.pickLiveEntry(s);
      if (afterWarm) return afterWarm;
    }

    // Establish fresh (deduped via inflight for concurrent callers).
    return this.startEstablish(domain, s);
  }

  /** Close all sessions (for cleanup). */
  closeAll(): void {
    for (const [, s] of this.domains) {
      for (const entry of s.entries) {
        if (!entry.session.closed && !entry.session.destroyed) {
          entry.session.close();
        }
      }
    }
    this.domains.clear();
  }
}

export const h2Pool = new H2Pool({ maxConnections: () => settings.h2PoolSize });
