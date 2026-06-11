import { EventEmitter } from 'events';
import type http2 from 'http2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createH2Fetch,
  createPoolBackedH2Fetch,
  h2RequestDirectFromPool,
  h2RequestDirect,
} from '../../../@blaxel/core/src/common/h2fetch.js';
import { markH2SessionIdleUnref } from '../../../@blaxel/core/src/common/h2ref.js';
import { H2Pool, h2Pool } from '../../../@blaxel/core/src/common/h2pool.js';
import { SandboxAction } from '../../../@blaxel/core/src/sandbox/action.js';

/**
 * Minimal ClientHttp2Stream stand-in. Supports the subset of the API that
 * h2fetch.ts uses: `on`, `close`, `end`.
 */
class MockStream extends EventEmitter {
  public closed = false;

  close(): void {
    this.closed = true;
  }

  end(): void {
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
  public streams: MockStream[] = [];
  public pingMode: 'ok' | 'fail' | 'hang' = 'ok';
  public refCalls = 0;
  public unrefCalls = 0;

  request(): MockStream {
    const stream = new MockStream();
    this.lastStream = stream;
    this.streams.push(stream);
    return stream;
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  ref(): this {
    this.refCalls++;
    return this;
  }

  unref(): this {
    this.unrefCalls++;
    return this;
  }

  ping(callback: (err?: Error | null) => void): boolean {
    if (this.pingMode === 'hang') return true;
    setImmediate(() => {
      callback(this.pingMode === 'fail' ? new Error('ping failed') : null);
    });
    return true;
  }
}

function asSession(mock: MockSession): http2.ClientHttp2Session {
  return mock as unknown as http2.ClientHttp2Session;
}

class H2ProbeAction extends SandboxAction {
  fetchWithH2(input: string): Promise<Response> {
    return this.h2Fetch(input);
  }
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

  it('rejects when the session closes before a response arrives', async () => {
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
    session.emit('close');

    await expect(promise).rejects.toThrow('HTTP/2 session closed before response');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when the session sends GOAWAY before a response arrives', async () => {
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
    session.emit('goaway');

    await expect(promise).rejects.toThrow('HTTP/2 session sent GOAWAY before response');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('raises the session listener budget for concurrent request lifecycle listeners', async () => {
    const session = new MockSession();

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.getMaxListeners()).toBeGreaterThanOrEqual(100);

    session.lastStream!.emit('response', { ':status': 200 });
    session.lastStream!.emit('end');

    const response = await promise;
    expect(response.status).toBe(200);
  });

  it('does not ref caller-owned sessions that were not marked idle-unref', async () => {
    const session = new MockSession();

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.refCalls).toBe(0);
    expect(session.unrefCalls).toBe(0);

    session.lastStream!.emit('response', { ':status': 200 });
    const response = await promise;
    session.lastStream!.emit('end');

    await expect(response.text()).resolves.toBe('');
    expect(session.refCalls).toBe(0);
    expect(session.unrefCalls).toBe(0);
  });

  it('refs an idle-unref H2 session while the response body is active', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.refCalls).toBe(1);
    expect(session.unrefCalls).toBe(1);

    session.lastStream!.emit('response', { ':status': 200 });
    const response = await promise;

    expect(response.status).toBe(200);
    expect(session.unrefCalls).toBe(1);

    session.lastStream!.emit('data', Buffer.from('ok'));
    session.lastStream!.emit('end');

    await expect(response.text()).resolves.toBe('ok');
    expect(session.unrefCalls).toBe(2);
  });

  it('keeps an idle-unref H2 session refed until all concurrent responses finish', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));

    const firstPromise = h2RequestDirect(
      asSession(session),
      'http://example.com/first',
      { method: 'POST', body: 'first' },
    );
    const firstStream = session.lastStream!;

    const secondPromise = h2RequestDirect(
      asSession(session),
      'http://example.com/second',
      { method: 'POST', body: 'second' },
    );
    const secondStream = session.lastStream!;

    expect(session.refCalls).toBe(1);
    expect(session.unrefCalls).toBe(1);
    expect(session.streams).toHaveLength(2);

    firstStream.emit('response', { ':status': 200 });
    secondStream.emit('response', { ':status': 200 });
    const firstResponse = await firstPromise;
    const secondResponse = await secondPromise;

    firstStream.emit('data', Buffer.from('one'));
    firstStream.emit('end');
    await expect(firstResponse.text()).resolves.toBe('one');

    expect(session.unrefCalls).toBe(1);

    secondStream.emit('data', Buffer.from('two'));
    secondStream.emit('end');
    await expect(secondResponse.text()).resolves.toBe('two');

    expect(session.unrefCalls).toBe(2);
  });

  it('restores idle-unref when the request fails before response', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.refCalls).toBe(1);
    session.lastStream!.emit('error', new Error('stream dead'));

    await expect(promise).rejects.toThrow('stream dead');
    expect(session.unrefCalls).toBe(2);
  });

  it('restores idle-unref when the request is aborted before response', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));
    const controller = new AbortController();

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload', signal: controller.signal },
    );

    expect(session.refCalls).toBe(1);
    controller.abort();

    await expect(promise).rejects.toThrow('The operation was aborted.');
    expect(session.unrefCalls).toBe(2);
  });

  it('restores idle-unref when the response body is cancelled', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    session.lastStream!.emit('response', { ':status': 200 });
    const response = await promise;

    await response.body?.cancel();

    expect(session.unrefCalls).toBe(2);
    expect(session.lastStream!.closed).toBe(true);
  });

  it('restores idle-unref when the response body errors', async () => {
    const session = new MockSession();
    markH2SessionIdleUnref(asSession(session));

    const promise = h2RequestDirect(
      asSession(session),
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    expect(session.refCalls).toBe(1);
    session.lastStream!.emit('response', { ':status': 200 });
    const response = await promise;

    session.lastStream!.emit('error', new Error('body broke'));

    await expect(response.text()).rejects.toThrow('body broke');
    expect(session.unrefCalls).toBe(2);
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

  it('falls back before creating an H2 stream for unsupported pooled direct bodies', async () => {
    const pool = new H2Pool();
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, 'request');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('fallback'));
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);

    const form = new FormData();
    form.append('file', new Blob(['payload']), 'payload.txt');

    const response = await h2RequestDirectFromPool(
      pool,
      'edge.example.com',
      'http://example.com/resource',
      { method: 'PUT', body: form },
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pool.tryGet('edge.example.com')).toBe(session);
    await expect(response.text()).resolves.toBe('fallback');
  });
});

describe('h2pool: self-healing eviction on session events', () => {
  function installMockEstablish(
    pool: H2Pool,
  ): (domain: string) => Promise<MockSession> {
    const establish = vi.fn(() => Promise.resolve(new MockSession()));
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
      () => {
        const s = new MockSession();
        sessions.push(s);
        return Promise.resolve(s);
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

  it('pings an idle cached session before reusing it', async () => {
    let now = 0;
    const pool = new H2Pool({
      maxIdleMs: 5,
      now: () => now,
    });
    installMockEstablish(pool);

    const session = await pool.get('edge.example.com');
    expect(session).not.toBeNull();

    now = 10;
    const reused = await pool.get('edge.example.com');

    expect(reused).toBe(session);
  });

  it('evicts an idle cached session when ping fails and opens a fresh one', async () => {
    let now = 0;
    const pool = new H2Pool({
      maxIdleMs: 5,
      now: () => now,
    });
    const sessions: MockSession[] = [];
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => {
        const s = new MockSession();
        sessions.push(s);
        return Promise.resolve(s);
      };

    const first = await pool.get('edge.example.com');
    expect(first).toBe(sessions[0]);

    sessions[0].pingMode = 'fail';
    now = 10;

    const fresh = await pool.get('edge.example.com');

    expect(fresh).toBe(sessions[1]);
    expect(sessions[0].closed).toBe(true);
    expect(pool.tryGet('edge.example.com')).toBe(sessions[1]);
  });

  it('evicts an idle cached session when ping times out', async () => {
    let now = 0;
    const pool = new H2Pool({
      maxIdleMs: 5,
      pingTimeoutMs: 1,
      now: () => now,
    });
    const sessions: MockSession[] = [];
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => {
        const s = new MockSession();
        sessions.push(s);
        return Promise.resolve(s);
      };

    const first = await pool.get('edge.example.com');
    expect(first).toBe(sessions[0]);

    sessions[0].pingMode = 'hang';
    now = 10;

    const fresh = await pool.get('edge.example.com');

    expect(fresh).toBe(sessions[1]);
    expect(sessions[0].closed).toBe(true);
  });

  it('evicts a pooled session when an H2 request errors before response', async () => {
    const pool = new H2Pool();
    const sessions: MockSession[] = [];
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => {
        const s = new MockSession();
        sessions.push(s);
        return Promise.resolve(s);
      };

    const promise = h2RequestDirectFromPool(
      pool,
      'edge.example.com',
      'http://example.com/resource',
      { method: 'POST', body: 'payload' },
    );

    await new Promise((r) => setImmediate(r));
    expect(sessions[0].lastStream).not.toBeNull();
    sessions[0].lastStream!.emit('error', new Error('stream dead'));

    await expect(promise).rejects.toThrow('stream dead');

    const fresh = await pool.get('edge.example.com');
    expect(fresh).toBe(sessions[1]);
    expect(sessions[0].closed).toBe(true);
  });

  it('keeps a pooled session when pre-flight fallback fetch fails', async () => {
    const pool = new H2Pool();
    const session = new MockSession();
    vi.spyOn(session, 'request').mockImplementation(() => {
      throw new Error('max concurrent streams');
    });
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fallback failed'));

    await expect(
      h2RequestDirectFromPool(
        pool,
        'edge.example.com',
        'http://example.com/resource',
      ),
    ).rejects.toThrow('fallback failed');

    expect(pool.tryGet('edge.example.com')).toBe(session);
    expect(session.closed).toBe(false);
  });

  it('keeps a pooled fetch session when pre-flight fallback fetch fails', async () => {
    const pool = new H2Pool();
    const session = new MockSession();
    vi.spyOn(session, 'request').mockImplementation(() => {
      throw new Error('max concurrent streams');
    });
    (pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fallback failed'));

    const h2fetch = createPoolBackedH2Fetch(pool, 'edge.example.com');

    await expect(
      h2fetch(new Request('http://example.com/resource')),
    ).rejects.toThrow('fallback failed');

    expect(pool.tryGet('edge.example.com')).toBe(session);
    expect(session.closed).toBe(false);
  });
});

describe('sandbox actions: pool-backed H2 routing', () => {
  afterEach(() => {
    h2Pool.closeAll();
    vi.restoreAllMocks();
  });

  it('does not reuse the raw session attached at sandbox creation', async () => {
    const staleAttachedSession = new MockSession();
    const staleRequestSpy = vi.spyOn(staleAttachedSession, 'request');
    const freshSession = new MockSession();
    const freshRequestSpy = vi.spyOn(freshSession, 'request');

    h2Pool.closeAll();
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(freshSession);

    const action = new H2ProbeAction({
      metadata: {
        name: 'sandbox-test',
        url: 'http://example.com',
      },
      spec: {},
      h2Session: asSession(staleAttachedSession),
      h2Domain: 'edge.example.com',
    });

    const responsePromise = action.fetchWithH2('http://example.com/resource');
    await new Promise((r) => setImmediate(r));

    expect(staleRequestSpy).not.toHaveBeenCalled();
    expect(freshRequestSpy).toHaveBeenCalledTimes(1);
    expect(freshSession.lastStream).not.toBeNull();

    freshSession.lastStream!.emit('response', { ':status': 200 });
    freshSession.lastStream!.emit('end');

    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it('uses global fetch when BL_DISABLE_H2 is set', async () => {
    const previousDisableH2 = process.env.BL_DISABLE_H2;
    process.env.BL_DISABLE_H2 = '1';

    try {
      const session = new MockSession();
      const requestSpy = vi.spyOn(session, 'request');
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('fallback'));
      (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
        () => Promise.resolve(session);

      const action = new H2ProbeAction({
        metadata: {
          name: 'sandbox-test',
          url: 'http://example.com',
        },
        spec: {},
        h2Session: asSession(session),
        h2Domain: 'edge.example.com',
      });

      const response = await action.fetchWithH2('http://example.com/resource');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).not.toHaveBeenCalled();
      await expect(response.text()).resolves.toBe('fallback');
    } finally {
      if (previousDisableH2 === undefined) {
        delete process.env.BL_DISABLE_H2;
      } else {
        process.env.BL_DISABLE_H2 = previousDisableH2;
      }
    }
  });
});
