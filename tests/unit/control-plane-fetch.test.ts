import { EventEmitter } from "events";
import { client } from "../../@blaxel/core/src/client/client.gen.js";
import { initialize } from "../../@blaxel/core/src/common/autoload.js";
import { controlPlaneFetch, shouldUseControlPlaneH2, undiciSupportsNativeH2 } from "../../@blaxel/core/src/common/controlPlaneFetch.js";
import { h2Pool } from "../../@blaxel/core/src/common/h2pool.js";
import { settings } from "../../@blaxel/core/src/common/settings.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("control-plane H2 routing predicate", () => {
  // Proves Blaxel API hosts engage the H2 pool, which is the TLS storm fix.
  it("routes HTTPS Blaxel control-plane hosts through the H2 pool so bursts share one TLS connection", () => {
    expect(shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/sandboxes"), false)).toBe(true);
    expect(shouldUseControlPlaneH2(new URL("https://api.blaxel.dev/v0/sandboxes"), false)).toBe(true);
  });

  // Proves custom control-plane hosts stay on native fetch to avoid repeated failed H2 setup.
  it("keeps custom hosts on native fetch so non-Blaxel gateways do not pay failed H2 setup per request", () => {
    expect(shouldUseControlPlaneH2(new URL("https://api.example.com/v0/sandboxes"), false)).toBe(false);
  });

  // Proves non-TLS URLs stay off the H2 pool because the pool establishes TLS sessions only.
  it("keeps non-HTTPS requests on native fetch because the H2 pool only establishes TLS sessions", () => {
    expect(shouldUseControlPlaneH2(new URL("http://api.blaxel.ai/v0/sandboxes"), false)).toBe(false);
  });

  // Proves the existing disable flag remains the single escape hatch for SDK H2 transport.
  it("honors the H2 disable flag as the single transport escape hatch", () => {
    expect(shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/sandboxes"), true)).toBe(false);
  });

  // Proves explicit proxy configuration preserves native fetch routing for control-plane calls.
  it("keeps proxy-configured control-plane URLs on native fetch so proxy routing remains unchanged", () => {
    expect(shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/proxy/api/sandboxes"), false, true)).toBe(false);
  });

  // Proves device-mode/client-credential token refresh stays on native fetch;
  // auth refresh is sequential and must not block the create-burst H2 fix.
  it("keeps oauth token refresh on native fetch", () => {
    expect(shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/oauth/token"), false)).toBe(false);
  });

  // Pins the empirical native-H2 boundary: Node's global fetch dispatcher only
  // ALPNs h2 by default from undici 8 (Node 26+). undici 6 (Node 22) and undici
  // 7 (Node 24) still negotiate HTTP/1.1, so they must keep the wrapper.
  it("treats undici >= 8 as native-H2 capable and undici <= 7 / unknown as not", () => {
    expect(undiciSupportsNativeH2("6.24.1")).toBe(false); // Node 22
    expect(undiciSupportsNativeH2("7.25.0")).toBe(false); // Node 24
    expect(undiciSupportsNativeH2("8.3.0")).toBe(true); // Node 26
    expect(undiciSupportsNativeH2(undefined)).toBe(false); // Bun/Deno/CF Workers
  });

  // Proves modern runtimes (undici >= 8) skip the redundant wrapper and use
  // native fetch, which already negotiates HTTP/2 via ALPN.
  it("skips the wrapper when native fetch already negotiates HTTP/2", () => {
    expect(
      shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/sandboxes"), false, false, true),
    ).toBe(false);
  });

  // Proves old/unknown runtimes (undici <= 6 or undefined on Bun/Deno) keep the
  // wrapper, since native fetch there is HTTP/1.1 only.
  it("uses the wrapper when native fetch lacks HTTP/2", () => {
    expect(
      shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/sandboxes"), false, false, false),
    ).toBe(true);
  });

  // Proves the force flag re-enables the pooled path on modern runtimes so the
  // wrapper stays testable where native fetch would otherwise win.
  it("forces the wrapper on modern runtimes when forceWrapper is set", () => {
    expect(
      shouldUseControlPlaneH2(new URL("https://api.blaxel.ai/v0/sandboxes"), false, false, true, true),
    ).toBe(true);
  });

  // Proves forceControlPlaneH2 reads from config and env.
  it("honors forceControlPlaneH2 as a settings flag", () => {
    const originalSettingsConfig = settings.config;
    try {
      settings.setConfig({ ...settings.config, forceControlPlaneH2: true });
      expect(settings.forceControlPlaneH2).toBe(true);
      settings.setConfig({ ...settings.config, forceControlPlaneH2: false });
      expect(settings.forceControlPlaneH2).toBe(false);
    } finally {
      settings.setConfig(originalSettingsConfig);
    }
  });

  // Proves the control-plane-only disable flag routes control-plane calls
  // through native fetch while leaving data-plane H2 untouched.
  it("honors disableControlPlaneH2 as a control-plane-only escape hatch", () => {
    const originalSettingsConfig = settings.config;
    try {
      settings.setConfig({ ...settings.config, disableControlPlaneH2: false });
      expect(settings.disableControlPlaneH2).toBe(false);

      settings.setConfig({ ...settings.config, disableControlPlaneH2: true });
      expect(settings.disableControlPlaneH2).toBe(true);
      // The merged flag the wrapper computes routes control-plane calls to native fetch.
      expect(
        shouldUseControlPlaneH2(
          new URL("https://api.blaxel.ai/v0/sandboxes"),
          settings.disableH2 || settings.disableControlPlaneH2,
        ),
      ).toBe(false);
    } finally {
      settings.setConfig(originalSettingsConfig);
    }
  });

  // Proves programmatic SDK config cannot drop the custom generated-client
  // fetch hook that routes sandbox creates through the control-plane H2 pool.
  it("keeps controlPlaneFetch installed after initialize reconfigures the generated client", () => {
    const originalClientConfig = client.getConfig();
    const originalSettingsConfig = settings.config;
    try {
      initialize({ ...settings.config });
      expect(client.getConfig().fetch).toBe(controlPlaneFetch);
    } finally {
      settings.setConfig(originalSettingsConfig);
      client.setConfig(originalClientConfig);
    }
  });
});

/**
 * Minimal ClientHttp2Session / stream stand-ins so controlPlaneFetch can be
 * driven end-to-end (through createPoolBackedH2Fetch -> the H2 gateway ->
 * _h2Request) without a real socket. The test emits the response lifecycle by
 * hand.
 */
class MockStream extends EventEmitter {
  public closed = false;
  close(): void {
    this.closed = true;
  }
  end(): void {
    // no-op
  }
}

class MockSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  public lastStream: MockStream | null = null;
  public streams: MockStream[] = [];
  request(): MockStream {
    const stream = new MockStream();
    this.lastStream = stream;
    this.streams.push(stream);
    return stream;
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// controlPlaneFetch is the fetch hook installed on the generated client. It
// decides, per request, whether to route through the pooled H2 wrapper or fall
// straight to globalThis.fetch. These drive the ACTUAL function (not just the
// pure predicate) so the routing wiring — env/config gating, the fallback, and
// the pooled send — is covered, not just shouldUseControlPlaneH2 in isolation.
//
// NB: on this runner (undici 6) nativeFetchSupportsH2 is false, so a qualifying
// Blaxel HTTPS request engages the wrapper without needing forceControlPlaneH2.
describe("controlPlaneFetch routing (end to end)", () => {
  afterEach(() => {
    h2Pool.closeAll();
    vi.restoreAllMocks();
    delete settings.config.disableH2;
    delete settings.config.disableControlPlaneH2;
    delete (settings.config as Record<string, unknown>).proxy;
  });

  it.each([
    ["a non-HTTPS URL", "http://api.blaxel.ai/v0/sandboxes"],
    ["a non-Blaxel host", "https://api.example.com/v0/sandboxes"],
    ["the oauth token refresh path", "https://api.blaxel.ai/v0/oauth/token"],
  ])("falls back to globalThis.fetch for %s (no H2 stream opened)", async (_label, url) => {
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, "request");
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("native"));

    const res = await controlPlaneFetch(new Request(url));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    await expect(res.text()).resolves.toBe("native");
  });

  it("falls back to globalThis.fetch when disableH2 is set, even for a Blaxel HTTPS host", async () => {
    settings.config.disableH2 = true;
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, "request");
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("native"));

    const res = await controlPlaneFetch(new Request("https://api.blaxel.ai/v0/sandboxes"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    await expect(res.text()).resolves.toBe("native");
  });

  it("falls back to globalThis.fetch for a Blaxel host when disableControlPlaneH2 is set but data-plane H2 stays available", async () => {
    settings.config.disableControlPlaneH2 = true;
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, "request");
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("native"));

    const res = await controlPlaneFetch(new Request("https://api.blaxel.ai/v0/sandboxes"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    await expect(res.text()).resolves.toBe("native");
  });

  it("routes a qualifying Blaxel HTTPS request through the pooled H2 transport (no native fetch send)", async () => {
    const session = new MockSession();
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => Promise.resolve(session);
    // If the wrapper is engaged, the send goes over the H2 stream, NOT
    // globalThis.fetch; a call here would mean an unexpected fallback.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("native-should-not-run"));

    const promise = controlPlaneFetch(
      new Request("https://api.blaxel.ai/v0/sandboxes"),
    );
    await tick();

    expect(session.lastStream).not.toBeNull();
    session.lastStream!.emit("response", { ":status": 200 });
    session.lastStream!.emit("data", Buffer.from("h2-body"));
    session.lastStream!.emit("end");

    const res = await promise;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("h2-body");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reuses one pooled H2 fetch per host across calls (single established session)", async () => {
    const sessions: MockSession[] = [];
    (h2Pool as unknown as { _establish: (d: string) => Promise<MockSession> })._establish =
      () => {
        const s = new MockSession();
        sessions.push(s);
        return Promise.resolve(s);
      };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("native"));

    const drive = async () => {
      const p = controlPlaneFetch(new Request("https://api.blaxel.dev/v0/sandboxes"));
      await tick();
      const s = sessions.at(-1)!;
      s.lastStream!.emit("response", { ":status": 200 });
      s.lastStream!.emit("end");
      return p;
    };

    await drive();
    await drive();

    // Both calls shared one pooled session for the host (warm/get dedup), so
    // establish ran exactly once rather than per request.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].streams).toHaveLength(2);
  });
});
