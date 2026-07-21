import type http2 from "http2";

type EstablishFn = (hostname: string) => Promise<http2.ClientHttp2Session>;
type NowFn = () => number;

type H2PoolEntry = {
  session: http2.ClientHttp2Session;
  lastUsedAt: number;
};

export type H2PoolOptions = {
  maxIdleMs?: number;
  pingTimeoutMs?: number;
  now?: NowFn;
};

const DEFAULT_MAX_IDLE_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 500;

/**
 * Singleton H2 session pool keyed by edge domain.
 *
 * - `warm(domain)` starts a background connection (fire-and-forget).
 * - `get(domain)` returns a live session immediately if cached, or awaits
 *   an in-flight warming, or establishes a fresh one.
 * - Closed / destroyed sessions are automatically evicted.
 */
export class H2Pool {
  private sessions = new Map<string, H2PoolEntry>();
  private inflight = new Map<string, Promise<http2.ClientHttp2Session | null>>();
  private _establish: EstablishFn | null = null;
  private readonly maxIdleMs: number;
  private readonly pingTimeoutMs: number;
  private readonly now: NowFn;

  constructor(options: H2PoolOptions = {}) {
    this.maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Lazily resolve the establish function so the http2 / tls / dns modules
   * are only imported in Node.js environments.
   *
   * Wires up self-healing eviction: the session is removed from the cache
   * as soon as it emits `goaway`, `error`, or `close`, so `tryGet()` never
   * returns a dead session. This replaces the old behavior of papering
   * over session failures at the fetch layer.
   */
  private async establish(domain: string): Promise<http2.ClientHttp2Session> {
    if (!this._establish) {
      const { establishH2 } = await import("./h2warm.js");
      this._establish = establishH2;
    }
    const session = await this._establish(domain);
    this.attachEvictionListeners(domain, session);
    return session;
  }

  private attachEvictionListeners(
    domain: string,
    session: http2.ClientHttp2Session,
  ): void {
    const evict = () => {
      // Only evict if this specific session is still the cached one.
      // A newer session may have taken its place after reconnect.
      if (this.sessions.get(domain)?.session === session) {
        this.sessions.delete(domain);
      }
    };
    session.on("goaway", evict);
    session.on("error", evict);
    session.on("close", evict);
  }

  private isClosed(session: http2.ClientHttp2Session): boolean {
    return session.closed || session.destroyed;
  }

  private isIdle(entry: H2PoolEntry): boolean {
    return this.now() - entry.lastUsedAt > this.maxIdleMs;
  }

  private cache(domain: string, session: http2.ClientHttp2Session): void {
    this.sessions.set(domain, {
      session,
      lastUsedAt: this.now(),
    });
  }

  private markUsed(domain: string, session: http2.ClientHttp2Session): void {
    const entry = this.sessions.get(domain);
    if (entry?.session === session) {
      entry.lastUsedAt = this.now();
    }
  }

  private evict(domain: string, session?: http2.ClientHttp2Session): void {
    const entry = this.sessions.get(domain);
    if (!entry) return;
    if (session && entry.session !== session) return;
    this.sessions.delete(domain);
    if (!entry.session.closed && !entry.session.destroyed) {
      entry.session.close();
    }
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

  private async validateEntry(
    domain: string,
    entry: H2PoolEntry | undefined,
  ): Promise<http2.ClientHttp2Session | null> {
    if (!entry) return null;
    const { session } = entry;
    if (this.isClosed(session)) {
      this.evict(domain, session);
      return null;
    }
    if (!this.isIdle(entry)) {
      this.markUsed(domain, session);
      return session;
    }
    if (await this.ping(session)) {
      // ENG-2676 generation/identity pin: `await this.ping` yields, and during
      // that await an eviction listener (goaway/error/close ->
      // attachEvictionListeners, see above) may have deleted or replaced this
      // entry. `entry` is the exact object held in the map, so if it is no
      // longer the cached generation, refuse the now-stale session instead of
      // handing back a zombie — the ENG-2422 failure re-entering through the
      // validate race. The caller falls through to establish a fresh session.
      if (this.sessions.get(domain) !== entry) return null;
      this.markUsed(domain, session);
      return session;
    }
    this.evict(domain, session);
    return null;
  }

  /**
   * Fire-and-forget background warming. Safe to call multiple times for
   * the same domain — only one connection attempt per domain at a time.
   */
  warm(domain: string): void {
    const existing = this.tryGet(domain);
    if (existing) return;
    if (this.inflight.has(domain)) return;

    const p = this.establish(domain)
      .then((session) => {
        this.cache(domain, session);
        return session;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(domain);
      });

    this.inflight.set(domain, p);
  }

  /**
   * Synchronous cache check. Returns a live cached session or `null`.
   * Never blocks, never establishes — use for non-blocking fast paths.
   */
  tryGet(domain: string): http2.ClientHttp2Session | null {
    const cached = this.sessions.get(domain);
    if (!cached) return null;
    if (this.isClosed(cached.session) || this.isIdle(cached)) {
      this.evict(domain, cached.session);
      return null;
    }
    this.markUsed(domain, cached.session);
    return cached.session;
  }

  isUsable(session: http2.ClientHttp2Session): boolean {
    return !this.isClosed(session);
  }

  evictSession(domain: string, session: http2.ClientHttp2Session): void {
    this.evict(domain, session);
  }

  /**
   * Get a live H2 session for `domain`. Returns immediately from cache,
   * joins an in-flight warming, or starts a new one.
   */
  async get(domain: string): Promise<http2.ClientHttp2Session | null> {
    const fast = await this.validateEntry(domain, this.sessions.get(domain));
    if (fast) return fast;

    // Join in-flight warming if one exists
    const pending = this.inflight.get(domain);
    if (pending) {
      const session = await pending;
      if (session && this.isUsable(session)) {
        this.markUsed(domain, session);
        return session;
      }
    }
    // Start fresh, deduplicating concurrent callers via inflight
    // Re-check: another caller may have started a fresh one while we awaited
    const existingInflight = this.inflight.get(domain);
    if (existingInflight) return existingInflight;

    const freshCached = this.tryGet(domain);
    if (freshCached) return freshCached;

    const p = this.establish(domain)
      .then((session) => {
        this.cache(domain, session);
        return session;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(domain);
      });
    this.inflight.set(domain, p);
    return p;
  }
  /** Close all sessions (for cleanup). */
  closeAll(): void {
    for (const [, entry] of this.sessions) {
      if (!entry.session.closed && !entry.session.destroyed) entry.session.close();
    }
    this.sessions.clear();
    this.inflight.clear();
  }
}

export const h2Pool = new H2Pool();
