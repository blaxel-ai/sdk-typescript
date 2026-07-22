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
  exception: {
    values: Array<{
      type: string;
      value: string;
      stacktrace: { frames: Array<Record<string, unknown>> };
    }>;
  };
  tags: Record<string, string>;
};

function eventFromFetch(fetchMock: ReturnType<typeof vi.fn>): CapturedEvent {
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof request?.body !== "string") throw new Error("Expected a string Sentry envelope");
  return JSON.parse(request.body.split("\n")[2]) as CapturedEvent;
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
    vi.unstubAllGlobals();
    for (const listener of process.listeners("uncaughtExceptionMonitor")) {
      if (!originalMonitorListeners.includes(listener)) {
        process.removeListener("uncaughtExceptionMonitor", listener);
      }
    }
    vi.restoreAllMocks();
  });

  it("does not replace console.error or report caught errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
      expect(event.exception.values[0]).toMatchObject({
        type: "TypeError",
        value: "Unhandled SDK exception",
      });
      expect(event.tags).toEqual({
        "blaxel.version": "9.9.9",
        "blaxel.commit": "abcdef0",
        "blaxel.error_source": "unhandled-sdk-exception",
      });
      expect(event.tags).not.toHaveProperty("blaxel.workspace");
      const frames = event.exception.values[0].stacktrace.frames;
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { initSentry } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeApplicationError());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a forged owned path containing parent traversal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { initSentry } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeTraversalStackError());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains delivery setup failures without creating an unhandled rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    mockSettings.tracking = false;

    const { initSentry, isSentryInitialized } = await import("./sentry.js");
    initSentry();
    emitUncaughtExceptionMonitor(makeSdkError());

    expect(isSentryInitialized()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
