import type http2 from "http2";

type EstablishFn = (hostname: string) => Promise<http2.ClientHttp2Session>;

/**
 * Singleton H2 session pool keyed by edge domain.
 *
 * - `warm(domain)` starts a background connection (fire-and-forget).
 * - `get(domain)` returns a live session immediately if cached, or awaits
 *   an in-flight warming, or establishes a fresh one.
 * - Closed / destroyed sessions are automatically evicted.
 */
export class H2Pool {
  private sessions = new Map<string, http2.ClientHttp2Session>();
  private inflight = new Map<string, Promise<http2.ClientHttp2Session | null>>();
  private _establish: EstablishFn | null = null;

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
      if (this.sessions.get(domain) === session) {
        this.sessions.delete(domain);
      }
    };
    session.on("goaway", evict);
    session.on("error", evict);
    session.on("close", evict);
  }

  /**
   * Fire-and-forget background warming. Safe to call multiple times for
   * the same domain — only one connection attempt per domain at a time.
   */
  warm(domain: string): void {
    const existing = this.sessions.get(domain);
    if (existing && !existing.closed && !existing.destroyed) return;
    if (this.inflight.has(domain)) return;

    const p = this.establish(domain)
      .then((session) => {
        this.sessions.set(domain, session);
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
    if (cached && !cached.closed && !cached.destroyed) return cached;
    this.sessions.delete(domain);
    return null;
  }

  /**
   * Get a live H2 session for `domain`. Returns immediately from cache,
   * joins an in-flight warming, or starts a new one.
   */
  async get(domain: string): Promise<http2.ClientHttp2Session | null> {
    const fast = this.tryGet(domain);
    if (fast) return fast;

    // Join in-flight warming if one exists
    const pending = this.inflight.get(domain);
    if (pending) {
      const session = await pending;
      if (session && !session.closed && !session.destroyed) return session;
    }
    // Start fresh, deduplicating concurrent callers via inflight
    // Re-check: another caller may have started a fresh one while we awaited
    const existingInflight = this.inflight.get(domain);
    if (existingInflight) return existingInflight;

    const freshCached = this.tryGet(domain);
    if (freshCached) return freshCached;

    const p = this.establish(domain)
      .then((session) => {
        this.sessions.set(domain, session);
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
    for (const [, session] of this.sessions) {
      if (!session.closed && !session.destroyed) session.close();
    }
    this.sessions.clear();
    this.inflight.clear();
  }
}

export const h2Pool = new H2Pool();
