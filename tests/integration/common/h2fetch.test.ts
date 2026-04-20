import { EventEmitter } from 'events';
import type http2 from 'http2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createH2Fetch,
  h2RequestDirect,
} from '../../../@blaxel/core/src/common/h2fetch.js';
import { H2Pool } from '../../../@blaxel/core/src/common/h2pool.js';

/**
 * Minimal ClientHttp2Stream stand-in. Supports the subset of the API that
 * h2fetch.ts uses: `on`, `close`, `end`.
 */
class MockStream extends EventEmitter {
  public closed = false;

  close(): void {
    this.closed = true;
  }

  end(_chunk?: unknown): void {
    // no-op; tests drive the response lifecycle by emitting events directly
  }
}

/**
 * Minimal ClientHttp2Session stand-in. The tests poke at `lastStream` to
 * emit lifecycle events that h2fetch should react to.
 */
class MockSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  public lastStream: MockStream | null = null;

  request(_headers: http2.OutgoingHttpHeaders): MockStream {
    const stream = new MockStream();
    this.lastStream = stream;
    return stream;
  }
}

function asSession(mock: MockSession): http2.ClientHttp2Session {
  return mock as unknown as http2.ClientHttp2Session;
}

describe('h2fetch: no silent retry after session.request()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects on post-flight stream error for a POST instead of retrying via fetch', async () => {
    const session = new MockSession();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('from fetch'));

    const h2fetch = createH2Fetch(asSession(session));
    const promise = h2fetch(
      new Request('http://example.com/resource', {
        method: 'POST',
        body: 'payload',
      }),
    );

    // Wait a tick so _h2Request can await arrayBuffer() and call
    // session.request() before we emit the error.
    await new Promise((r) => setImmediate(r));
    expect(session.lastStream).not.toBeNull();

    session.lastStream!.emit('error', new Error('stream dead'));

    await expect(promise).rejects.toThrow('stream dead');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects on post-flight stream error for h2RequestDirect instead of retrying via fetch', async () => {
    const session = new MockSession();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('from fetch'));

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.lastStream).not.toBeNull();
    session.lastStream!.emit('error', new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not install a default timeout that silently falls back to fetch', async () => {
    vi.useFakeTimers();
    try {
      const session = new MockSession();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('from fetch'));

      const promise = h2RequestDirect(
        asSession(session),
        'http://example.com/resource',
        { method: 'POST', body: 'payload' },
      );

      // Attach a catch handler so advancing timers past any old default
      // timeout cannot produce an unhandled rejection in the fake-timer loop.
      const outcome: { settled: boolean; reason?: unknown; value?: Response } = {
        settled: false,
      };
      void promise.then(
        (value) => {
          outcome.settled = true;
          outcome.value = value;
        },
        (reason) => {
          outcome.settled = true;
          outcome.reason = reason;
        },
      );

      // Run well past the old 10s default-timeout window.
      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(outcome.settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('h2fetch: pre-flight fallback still works', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to globalThis.fetch when session is already closed at call time', async () => {
    const session = new MockSession();
    session.closed = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fallback'));

    const h2fetch = createH2Fetch(asSession(session));
    const response = await h2fetch(new Request('http://example.com/resource'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe('fallback');
  });

  it('falls back to globalThis.fetch when session is destroyed (h2RequestDirect)', async () => {
    const session = new MockSession();
    session.destroyed = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fallback'));

    const response = await h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe('fallback');
  });

  it('falls back to globalThis.fetch when session.request() throws synchronously', async () => {
    const session = new MockSession();
    vi.spyOn(session, 'request').mockImplementation(() => {
      throw new Error('session went away');
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fallback'));

    const response = await h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe('fallback');
  });

  it('falls back to globalThis.fetch for unsupported body types in h2RequestDirect', async () => {
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, 'request');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fallback'));

    const form = new FormData();
    form.append('key', 'value');

    const response = await h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: form },
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe('fallback');
  });
});

describe('h2pool: self-healing eviction on session events', () => {
  function installMockEstablish(
    pool: H2Pool,
  ): (domain: string) => Promise<MockSession> {
    const establish = vi.fn(async (_domain: string) => new MockSession());
    // Access the private lazy-load slot via a cast; the eviction listeners
    // are wired inside establish() wrapper, which preserves this behavior.
    (pool as unknown as { _establish: typeof establish })._establish = establish;
    return establish;
  }

  it('evicts a cached session when it emits "goaway"', async () => {
    const pool = new H2Pool();
    installMockEstablish(pool);

    const session = await pool.get('edge.example.com');
    expect(session).not.toBeNull();
    expect(pool.tryGet('edge.example.com')).toBe(session);

    (session as unknown as MockSession).emit('goaway');

    expect(pool.tryGet('edge.example.com')).toBeNull();
  });

  it('evicts a cached session when it emits "error"', async () => {
    const pool = new H2Pool();
    installMockEstablish(pool);

    const session = await pool.get('edge.example.com');
    expect(pool.tryGet('edge.example.com')).toBe(session);

    (session as unknown as MockSession).emit('error', new Error('transport'));

    expect(pool.tryGet('edge.example.com')).toBeNull();
  });

  it('evicts a cached session when it emits "close"', async () => {
    const pool = new H2Pool();
    installMockEstablish(pool);

    const session = await pool.get('edge.example.com');
    expect(pool.tryGet('edge.example.com')).toBe(session);

    (session as unknown as MockSession).emit('close');

    expect(pool.tryGet('edge.example.com')).toBeNull();
  });

  it('does not wipe a fresh session that replaced the one that just evicted', async () => {
    const pool = new H2Pool();
    const sessions: MockSession[] = [];
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      async (_domain: string) => {
        const s = new MockSession();
        sessions.push(s);
        return s;
      };

    const first = await pool.get('edge.example.com');
    expect(first).toBe(sessions[0]);

    // A fresh session gets cached after the first one is evicted.
    const second = await pool.get('edge.example.com').then(async (s) => {
      if (s) return s;
      return pool.get('edge.example.com');
    });
    expect(second).toBe(sessions[0]);

    // Force eviction of the first by emitting close, then establish a new one.
    sessions[0].emit('close');
    expect(pool.tryGet('edge.example.com')).toBeNull();

    const fresh = await pool.get('edge.example.com');
    expect(fresh).toBe(sessions[1]);
    expect(pool.tryGet('edge.example.com')).toBe(sessions[1]);

    // Emitting a stale event on the *old* session must not touch the fresh one.
    sessions[0].emit('close');
    expect(pool.tryGet('edge.example.com')).toBe(sessions[1]);
  });
});
