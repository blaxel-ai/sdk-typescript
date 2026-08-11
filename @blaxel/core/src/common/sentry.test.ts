import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  tracking: true,
  sentryDsn: "https://public-key@sentry.example/123",
  env: "prod",
  version: "9.9.9",
  commit: "abcdef0",
  workspace: "private-workspace",
}));

vi.mock("./settings.js", () => ({ settings: mockSettings }));

const appFrameUrl = "file:///Users/customer/private-project/app.ts";

function makeSdkError(
  message = "secret response body for resource customer-123"
): Error {
  // This helper lives under the exact @blaxel/core source root, so its real
  // runtime frame exercises package-root attribution without test hooks.
  return new TypeError(message);
}

function makeApplicationError(): Error {
  const sdkFrame = makeSdkError().stack
    ?.split("\n")
    .find((line) => line.includes("sentry.test"));
  if (!sdkFrame) throw new Error("Expected a real SDK test frame");

  const error = new Error("application secret");
  error.stack = [
    "Error: application secret",
    `    at application (${appFrameUrl}:10:20)`,
    sdkFrame,
  ].join("\n");
  return error;
}

function makeTraversalStackError(): Error {
  const sdkFrame = makeSdkError().stack
    ?.split("\n")
    .find((line) => line.includes("sentry.test"));
  if (!sdkFrame) throw new Error("Expected a real SDK test frame");

  const forgedFrame = sdkFrame.replace(
    /([\\/])src\1common\1sentry\.test\.ts/,
    "$1src$1..$1private$1customer-secret.ts"
  );
  if (forgedFrame === sdkFrame) throw new Error("Expected to forge the SDK frame path");

  const error = new Error("application secret");
  error.stack = ["Error: application secret", forgedFrame].join("\n");
  return error;
}

type CapturedEvent = {
  exception?: {
    values: Array<{
      type: string;
      value: string;
      stacktrace: { frames: Array<Record<string, unknown>> };
    }>;
  };
  extra?: { count?: number };
  fingerprint?: string[];
  level?: string;
  message?: string;
  tags: Record<string, string>;
};

function createFetchMock() {
  return vi.fn((input: unknown, init?: RequestInit): Promise<{ ok: boolean }> => {
    void input;
    void init;
    return Promise.resolve({ ok: true });
  });
}

type FetchMock = ReturnType<typeof createFetchMock>;

function eventFromFetch(fetchMock: FetchMock): CapturedEvent {
  const request = fetchMock.mock.calls[0]?.[1];
  if (typeof request?.body !== "string") throw new Error("Expected a string Sentry envelope");
  return JSON.parse(request.body.split("\n")[2]) as CapturedEvent;
}

function eventsFromFetch(fetchMock: FetchMock): CapturedEvent[] {
  return fetchMock.mock.calls.map((call) => {
    const request = call[1];
    if (typeof request?.body !== "string") {
      throw new Error("Expected a string Sentry envelope");
    }
    return JSON.parse(request.body.split("\n")[2]) as CapturedEvent;
  });
}

function emitUncaughtExceptionMonitor(error: Error): boolean {
  const processWithStringEvents = process as unknown as {
    emit(event: string, ...args: unknown[]): boolean;
  };
  return processWithStringEvents.emit(
    "uncaughtExceptionMonitor",
    error,
    "uncaughtException"
  );
}

describe("SDK Sentry boundary", () => {
  let originalMonitorListeners: Array<(...args: any[]) => void>;

  beforeEach(() => {
    vi.resetModules();
    mockSettings.tracking = true;
    mockSettings.sentryDsn = "https://public-key@sentry.example/123";
    mockSettings.env = "prod";
    originalMonitorListeners = process.listeners("uncaughtExceptionMonitor") as Array<
      (...args: any[]) => void
    >;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("./node.js");
    vi.unstubAllGlobals();
    for (const listener of process.listeners("uncaughtExceptionMonitor")) {
      if (!originalMonitorListeners.includes(listener)) {
        process.removeListener("uncaughtExceptionMonitor", listener);
      }
    }
    vi.restoreAllMocks();
  });

  it("does not replace console.error or report caught errors", async () => {
    const fetchMock = createFetchMock();
    const hostConsoleError = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(hostConsoleError);

    const { initSentry } = await import("./sentry.js");
    initSentry();
    const installedConsoleError = console.error;

    console.error(makeSdkError());

    expect(console.error).toBe(installedConsoleError);
    expect(hostConsoleError).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("composes with host handlers and reports one sanitized SDK-owned event", async () => {
    const fetchMock = createFetchMock();
    const hostMonitor = vi.fn();
    const hostRejection = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.on("uncaughtExceptionMonitor", hostMonitor);
    process.on("unhandledRejection", hostRejection);
    const rejectionListeners = process.listeners("unhandledRejection");

    try {
      const { flushSentry, initSentry } = await import("./sentry.js");
      initSentry();
      const error = makeSdkError();

      emitUncaughtExceptionMonitor(error);
      emitUncaughtExceptionMonitor(error);
      await flushSentry();

      expect(hostMonitor).toHaveBeenCalledTimes(2);
      expect(process.listeners("unhandledRejection")).toEqual(rejectionListeners);
      expect(fetchMock).toHaveBeenCalledOnce();

      const event = eventFromFetch(fetchMock);
      expect(event.exception?.values[0]).toMatchObject({
        type: "TypeError",
        value: "Unhandled SDK exception",
      });
      expect(event.tags).toEqual({
        "blaxel.version": "9.9.9",
        "blaxel.commit": "abcdef0",
        "blaxel.error_source": "unhandled-sdk-exception",
      });
      expect(event.tags).not.toHaveProperty("blaxel.workspace");
      const frames = event.exception?.values[0]?.stacktrace.frames ?? [];
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.filename).toBe("@blaxel/core/src/common/sentry.test.ts");
      }

      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("secret response body");
      expect(serialized).not.toContain("customer-123");
      expect(serialized).not.toContain("private-workspace");
      expect(serialized).not.toContain("/Users/customer");
    } finally {
      process.removeListener("uncaughtExceptionMonitor", hostMonitor);
      process.removeListener("unhandledRejection", hostRejection);
    }
  });

  it("does not attribute an application-owned exception with a later SDK frame", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { initSentry } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeApplicationError());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a forged owned path containing parent traversal", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { initSentry } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeTraversalStackError());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains delivery setup failures without creating an unhandled rejection", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "AbortController",
      class FailingAbortController {
        constructor() {
          throw new Error("host AbortController failure");
        }
      }
    );

    const { flushSentry, initSentry } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeSdkError());
    await flushSentry();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("composes with browser handlers and ignores primitive rejections", async () => {
    const fetchMock = createFetchMock();
    const listeners = new Map<string, (event: unknown) => void>();
    const addEventListener = vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("addEventListener", addEventListener);

    const { flushSentry, initSentry } = await import("./sentry.js");
    initSentry();

    expect(addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));

    listeners.get("unhandledrejection")?.({ reason: "raw rejection secret" });
    listeners.get("error")?.({ error: makeSdkError() });
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(eventFromFetch(fetchMock))).not.toContain("raw rejection secret");
  });

  it("does not initialize when tracking is disabled", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockSettings.tracking = false;

    const {
      flushSentry,
      initSentry,
      isSentryInitialized,
      reportH2TransportDegradation,
    } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeSdkError());
    reportH2TransportDegradation(
      "sbx-test-workspace.us-pdx-1.bl.run",
      "no-session",
    );
    await flushSentry();

    expect(isSentryInitialized()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls a 100-fallback burst into one warning event", async () => {
    vi.useFakeTimers();
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();
    const domain = "sbx-test-workspace.us-pdx-1.bl.run";
    const domainTag = "blaxel-edge:prod:us-pdx-1";

    for (let index = 0; index < 100; index++) {
      reportH2TransportDegradation(domain, "no-session");
    }

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventFromFetch(fetchMock)).toMatchObject({
      level: "warning",
      message: "h2 transport degradation: no-session",
      fingerprint: ["h2-degradation", "no-session", domainTag],
      tags: {
        "blaxel.version": "9.9.9",
        "blaxel.commit": "abcdef0",
        "blaxel.error_source": "h2-transport-degradation",
        "blaxel.runtime": `node/${process.versions.node}`,
        reason: "no-session",
        domainTag,
      },
      extra: { count: 100 },
    });
  });

  it("groups keys independently and hashes external domains", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();
    const externalDomain = "customer.internal.example";
    const blaxelDomain = "sbx-test-workspace.us-pdx-1.bl.run";

    reportH2TransportDegradation(externalDomain, "no-session");
    reportH2TransportDegradation(externalDomain, "no-session");
    reportH2TransportDegradation(blaxelDomain, "request-rejected");
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const events = eventsFromFetch(fetchMock);
    const externalEvent = events.find(
      (event) => event.tags.reason === "no-session",
    );
    const blaxelEvent = events.find(
      (event) => event.tags.reason === "request-rejected",
    );

    expect(externalEvent).toMatchObject({ extra: { count: 2 } });
    expect(externalEvent?.tags.domainTag).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(externalEvent)).not.toContain(externalDomain);
    expect(blaxelEvent).toMatchObject({
      tags: { domainTag: "blaxel-edge:prod:us-pdx-1" },
      extra: { count: 1 },
    });
  });

  it("groups Blaxel edge hosts by environment and region", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();

    reportH2TransportDegradation(
      "sbx-first-workspace.us-pdx-1.bl.run",
      "no-session",
    );
    reportH2TransportDegradation(
      "sbx-second-workspace.us-pdx-1.bl.run",
      "no-session",
    );
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventFromFetch(fetchMock)).toMatchObject({
      fingerprint: [
        "h2-degradation",
        "no-session",
        "blaxel-edge:prod:us-pdx-1",
      ],
      extra: { count: 2 },
    });
  });

  it("keeps stable Blaxel control-plane domains identifiable", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();

    reportH2TransportDegradation("api.blaxel.ai", "no-session");
    await flushSentry();

    expect(eventFromFetch(fetchMock)).toMatchObject({
      tags: { domainTag: "blaxel-api:prod" },
      fingerprint: ["h2-degradation", "no-session", "blaxel-api:prod"],
    });
  });

  it("caps active rollup keys at 20", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();

    for (let index = 0; index < 21; index++) {
      reportH2TransportDegradation(
        `sbx-test-workspace.us-test-${index}.bl.run`,
        "no-session",
      );
    }
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("caps H2 degradation events at 100 per process", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();

    for (let index = 0; index < 101; index++) {
      reportH2TransportDegradation(
        "sbx-test-workspace.us-pdx-1.bl.run",
        "no-session",
      );
      await flushSentry();
    }

    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("fails closed when an external domain cannot be hashed", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("./node.js", () => ({
      crypto: {
        createHash: () => {
          throw new Error("hash unavailable");
        },
      },
    }));

    const { flushSentry, initSentry, reportH2TransportDegradation } = await import(
      "./sentry.js"
    );
    initSentry();

    expect(() =>
      reportH2TransportDegradation("private.customer.example", "no-session"),
    ).not.toThrow();
    await flushSentry();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports degradations through the H2 statistics hooks", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { flushSentry, initSentry } = await import("./sentry.js");
    initSentry();
    const { recordH2Fallback } = await import("./h2stats.js");

    recordH2Fallback(
      "sbx-test-workspace.us-pdx-1.bl.run",
      "unsupported-body",
    );
    await flushSentry();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventFromFetch(fetchMock)).toMatchObject({
      message: "h2 transport degradation: unsupported-body",
      extra: { count: 1 },
    });
  });
});
