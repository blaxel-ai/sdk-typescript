import { crypto } from "./node.js";
import { settings } from "./settings.js";
import type { H2FallbackReason } from "./h2stats.js";

type SentryConfig = {
  publicKey: string;
  host: string;
  projectId: string;
};

type ParsedFrame = {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
};

type SentryEvent = Record<string, unknown> & { event_id: string };

export type H2DegradationReason = "establish-failure" | H2FallbackReason;

type H2DegradationRollup = {
  count: number;
  domainTag: string;
  reason: H2DegradationReason;
  timer: ReturnType<typeof setTimeout>;
};

const PACKAGE_LAYOUT_MARKERS = [
  "/src/common/sentry.ts",
  "/dist/cjs/common/sentry.js",
  "/dist/esm/common/sentry.js",
  "/dist/cjs-browser/common/sentry.js",
  "/dist/esm-browser/common/sentry.js",
] as const;

const OWNED_PACKAGE_DIRECTORIES = [
  "/src/",
  "/dist/cjs/",
  "/dist/esm/",
  "/dist/cjs-browser/",
  "/dist/esm-browser/",
] as const;

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
]);

const MAX_IN_FLIGHT_EVENTS = 20;
const MAX_ACTIVE_H2_ROLLUPS = 20;
const MAX_CACHED_DOMAIN_TAGS = 100;
const MAX_H2_EVENTS_PER_PROCESS = 100;
const DELIVERY_TIMEOUT_MS = 500;
const H2_ROLLUP_WINDOW_MS = 60_000;
const SAFE_FILENAME_SEGMENT = /^[A-Za-z0-9._-]+$/;

let sentryInitialized = false;
let handlersRegistered = false;
let sentryConfig: SentryConfig | null = null;
let flushPromise: Promise<void> | null = null;

const capturedExceptions = new WeakSet<Error>();
const inFlightDeliveries = new Set<Promise<void>>();
const domainTagCache = new Map<string, string | null>();
const h2DegradationRollups = new Map<string, H2DegradationRollup>();
let h2EventsEmitted = 0;

/**
 * Normalize stack filenames without resolving or exposing host filesystem data.
 */
function normalizeFilename(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/[?#].*$/, "");
}

/**
 * Parse V8/Node and browser stack-frame formats in call order (newest first).
 */
function parseStackTrace(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];

  // V8 starts with an error header (which does not match a frame), while
  // Firefox-style stacks can start directly with the first frame.
  for (const line of stack.split("\n")) {
    const v8WithFunction = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/);
    const v8WithoutFunction = line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
    const browser = line.match(/^\s*(.*?)@(.+):(\d+):(\d+)\s*$/);

    const match = v8WithFunction ?? v8WithoutFunction ?? browser;
    if (!match) continue;

    if (match === v8WithFunction) {
      frames.push({
        function: match[1],
        filename: normalizeFilename(match[2]),
        lineno: Number.parseInt(match[3], 10),
        colno: Number.parseInt(match[4], 10),
      });
      continue;
    }

    if (match === browser) {
      frames.push({
        function: match[1] || "<anonymous>",
        filename: normalizeFilename(match[2]),
        lineno: Number.parseInt(match[3], 10),
        colno: Number.parseInt(match[4], 10),
      });
      continue;
    }

    frames.push({
      function: "<anonymous>",
      filename: normalizeFilename(match[1]),
      lineno: Number.parseInt(match[2], 10),
      colno: Number.parseInt(match[3], 10),
    });
  }

  return frames;
}

/**
 * Discover this exact @blaxel/core package root from this module's own frame.
 * This avoids trusting a generic "@blaxel" substring in an arbitrary stack.
 */
function discoverPackageRoot(stack: string): string | null {
  for (const frame of parseStackTrace(stack)) {
    for (const marker of PACKAGE_LAYOUT_MARKERS) {
      if (frame.filename.endsWith(marker)) {
        return frame.filename.slice(0, -marker.length);
      }
    }
  }
  return null;
}

const sdkPackageRoot = discoverPackageRoot(new Error().stack ?? "");

function isRuntimeFrame(filename: string): boolean {
  return filename.startsWith("node:") || filename.startsWith("internal/");
}

function ownedRelativeFilename(filename: string): string | null {
  if (!sdkPackageRoot) return null;

  for (const directory of OWNED_PACKAGE_DIRECTORIES) {
    const prefix = `${sdkPackageRoot}${directory}`;
    if (!filename.startsWith(prefix)) continue;

    const relativeFilename = filename.slice(sdkPackageRoot.length).replace(/^\/+/, "");
    const segments = relativeFilename.split("/");
    if (
      segments.length > 0 &&
      segments.every(
        (segment) =>
          segment !== "." && segment !== ".." && SAFE_FILENAME_SEGMENT.test(segment)
      )
    ) {
      return relativeFilename;
    }
  }

  return null;
}

function isOwnedFilename(filename: string): boolean {
  return ownedRelativeFilename(filename) !== null;
}

/**
 * Attribute an exception only when its first non-runtime frame is inside the
 * exact installed @blaxel/core package. Application and dependency frames are
 * never included in the event.
 */
function getOwnedFrames(error: Error): ParsedFrame[] {
  const frames = parseStackTrace(error.stack ?? "");
  const firstRelevantFrame = frames.find((frame) => !isRuntimeFrame(frame.filename));

  if (!firstRelevantFrame || !isOwnedFilename(firstRelevantFrame.filename)) {
    return [];
  }

  return frames.filter((frame) => isOwnedFilename(frame.filename));
}

function sanitizeFunctionName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120 || !/^[\w.$<> /-]+$/u.test(normalized)) {
    return "<sdk>";
  }
  return normalized;
}

function sanitizeOwnedFrame(frame: ParsedFrame): ParsedFrame {
  const relativeFilename = ownedRelativeFilename(frame.filename) ?? "unknown";

  return {
    function: sanitizeFunctionName(frame.function),
    filename: `@blaxel/core/${relativeFilename}`,
    lineno: frame.lineno,
    colno: frame.colno,
  };
}

function sanitizeErrorName(name: string): string {
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

/**
 * Parse a Sentry DSN into the public transport components used by envelopes.
 */
function parseDsn(dsn: string): SentryConfig | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const projectId = url.pathname.slice(1);

    if (!publicKey || !host || !projectId || !["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return { publicKey, host, projectId };
  } catch {
    return null;
  }
}

function generateEventId(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0;
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Build an allowlisted event. Raw messages, response bodies, workspace/resource
 * context, and absolute host paths are deliberately excluded.
 */
function errorToSentryEvent(error: Error, ownedFrames: ParsedFrame[]): SentryEvent {
  return {
    event_id: generateEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: settings.env,
    release: `sdk-typescript@${settings.version}`,
    tags: {
      "blaxel.version": settings.version,
      "blaxel.commit": settings.commit,
      "blaxel.error_source": "unhandled-sdk-exception",
    },
    exception: {
      values: [
        {
          type: sanitizeErrorName(error.name),
          value: "Unhandled SDK exception",
          stacktrace: {
            // Sentry expects oldest-to-newest frame order.
            frames: ownedFrames.map(sanitizeOwnedFrame).reverse(),
          },
        },
      ],
    },
  };
}

function runtimeTag(): string {
  const host = globalThis as typeof globalThis & {
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { bun?: string; node?: string } };
  };

  if (host.process?.versions?.bun) return `bun/${host.process.versions.bun}`;
  if (host.Deno?.version?.deno) return `deno/${host.Deno.version.deno}`;
  if (host.process?.versions?.node) return `node/${host.process.versions.node}`;
  return "browser";
}

function normalizeDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

function blaxelEdgeDomainTag(domain: string): string | null {
  const edgeSuffixes = [
    { environment: "prod", suffix: ".bl.run" },
    { environment: "dev", suffix: ".runv2.blaxel.dev" },
  ] as const;

  for (const { environment, suffix } of edgeSuffixes) {
    if (!domain.endsWith(suffix)) continue;

    const region = domain.slice(0, -suffix.length).split(".").at(-1);
    if (region && /^[a-z0-9-]+$/.test(region)) {
      return `blaxel-edge:${environment}:${region}`;
    }
    return null;
  }

  return null;
}

function uncachedDomainTag(domain: string): string | null {
  const stableBlaxelDomains: Record<string, string> = {
    "api.blaxel.ai": "blaxel-api:prod",
    "api.blaxel.dev": "blaxel-api:dev",
    "run.blaxel.ai": "blaxel-run:prod",
    "run.blaxel.dev": "blaxel-run:dev",
  };
  const stableTag = stableBlaxelDomains[domain];
  if (stableTag) return stableTag;

  const edgeTag = blaxelEdgeDomainTag(domain);
  if (edgeTag) return edgeTag;
  if (!crypto) return null;

  try {
    return `sha256:${crypto.createHash("sha256").update(domain).digest("hex")}`;
  } catch {
    return null;
  }
}

function domainToTag(domain: string): string | null {
  if (domainTagCache.has(domain)) return domainTagCache.get(domain) ?? null;

  const domainTag = uncachedDomainTag(domain);
  if (domainTagCache.size >= MAX_CACHED_DOMAIN_TAGS) {
    const oldestDomain = domainTagCache.keys().next().value;
    if (oldestDomain !== undefined) domainTagCache.delete(oldestDomain);
  }
  domainTagCache.set(domain, domainTag);
  return domainTag;
}

function h2DegradationToSentryEvent(
  reason: H2DegradationReason,
  domainTag: string,
  count: number,
): SentryEvent {
  return {
    event_id: generateEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "warning",
    environment: settings.env,
    release: `sdk-typescript@${settings.version}`,
    message: `h2 transport degradation: ${reason}`,
    fingerprint: ["h2-degradation", reason, domainTag],
    tags: {
      "blaxel.version": settings.version,
      "blaxel.commit": settings.commit,
      "blaxel.error_source": "h2-transport-degradation",
      "blaxel.runtime": runtimeTag(),
      reason,
      domainTag,
    },
    extra: { count },
  };
}

async function sendToSentry(event: SentryEvent): Promise<void> {
  if (!sentryConfig) return;

  const { publicKey, host, projectId } = sentryConfig;
  const envelopeUrl = `https://${host}/api/${projectId}/envelope/`;
  const envelopeHeader = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn: `https://${publicKey}@${host}/${projectId}`,
  });
  const itemHeader = JSON.stringify({
    type: "event",
    content_type: "application/json",
  });
  const envelope = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}`;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abortTimer = controller
    ? setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    : null;

  try {
    await fetch(envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=blaxel-sdk/${settings.version}, sentry_key=${publicKey}`,
      },
      body: envelope,
      keepalive: true,
      signal: controller?.signal,
    });
  } catch {
    // Error reporting must never affect the host application.
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

function scheduleDelivery(event: SentryEvent): boolean {
  if (inFlightDeliveries.size >= MAX_IN_FLIGHT_EVENTS) return false;

  // Contain rejections from setup that occurs before sendToSentry's internal
  // fetch guard (for example, a host-provided AbortController implementation).
  const delivery = sendToSentry(event).catch(() => undefined);
  inFlightDeliveries.add(delivery);
  void delivery.then(() => inFlightDeliveries.delete(delivery));
  return true;
}

function emitH2DegradationRollup(key: string): void {
  const rollup = h2DegradationRollups.get(key);
  if (!rollup) return;

  h2DegradationRollups.delete(key);
  clearTimeout(rollup.timer);
  if (h2EventsEmitted >= MAX_H2_EVENTS_PER_PROCESS) return;

  if (
    scheduleDelivery(
      h2DegradationToSentryEvent(rollup.reason, rollup.domainTag, rollup.count),
    )
  ) {
    h2EventsEmitted++;
  }
}

function flushH2DegradationRollups(): void {
  for (const key of [...h2DegradationRollups.keys()]) {
    emitH2DegradationRollup(key);
  }
}

/** @internal */
export function reportH2TransportDegradation(
  domain: string,
  reason: H2DegradationReason,
): void {
  if (!sentryInitialized || !sentryConfig) return;

  try {
    if (h2EventsEmitted >= MAX_H2_EVENTS_PER_PROCESS) return;

    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) return;

    const domainTag = domainToTag(normalizedDomain);
    if (!domainTag) return;

    const key = `${reason}\0${domainTag}`;
    const existing = h2DegradationRollups.get(key);
    if (existing) {
      existing.count++;
      return;
    }

    if (h2DegradationRollups.size >= MAX_ACTIVE_H2_ROLLUPS) return;

    const timer = setTimeout(() => {
      try {
        emitH2DegradationRollup(key);
      } catch {
        // Telemetry must never change transport behavior.
      }
    }, H2_ROLLUP_WINDOW_MS);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

    h2DegradationRollups.set(key, {
      count: 1,
      domainTag,
      reason,
      timer,
    });
  } catch {
    // Telemetry must never change transport behavior.
  }
}

function captureException(error: Error): void {
  if (!sentryInitialized || !sentryConfig || capturedExceptions.has(error)) {
    return;
  }

  try {
    const ownedFrames = getOwnedFrames(error);
    if (ownedFrames.length === 0) return;

    capturedExceptions.add(error);
    scheduleDelivery(errorToSentryEvent(error, ownedFrames));
  } catch {
    // Error reporting must never affect the host application.
  }
}

function registerBrowserHandlers(): void {
  const host = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  };

  if (typeof host.addEventListener !== "function") return;

  host.addEventListener.call(host, "error", (event: unknown) => {
    const error = (event as { error?: unknown }).error;
    if (error instanceof Error) captureException(error);
  });

  host.addEventListener.call(host, "unhandledrejection", (event: unknown) => {
    const reason = (event as { reason?: unknown }).reason;
    // A primitive rejection carries no attributable stack, so do not guess.
    if (reason instanceof Error) captureException(reason);
  });
}

/**
 * Initialize opt-in SDK error tracking. Registration composes with host global
 * handlers and never replaces console, process, or browser callbacks.
 */
export function initSentry(): void {
  try {
    if (!settings.tracking || !settings.sentryDsn || !sdkPackageRoot) return;

    const config = parseDsn(settings.sentryDsn);
    if (!config || (settings.env !== "dev" && settings.env !== "prod")) return;

    sentryConfig = config;
    sentryInitialized = true;

    if (handlersRegistered) return;
    handlersRegistered = true;

    if (
      typeof process !== "undefined" &&
      process.versions?.node &&
      typeof process.on === "function"
    ) {
      process.on("uncaughtExceptionMonitor", (error: Error) => {
        captureException(error);
      });
      return;
    }

    registerBrowserHandlers();
  } catch {
    // Initialization is intentionally silent and cannot break the SDK.
  }
}

/**
 * Await only deliveries already in flight, bounded by the supplied timeout.
 * Events are sent exactly once; flush never re-enqueues them.
 */
export async function flushSentry(timeout = DELIVERY_TIMEOUT_MS): Promise<void> {
  if (!sentryInitialized) return;

  try {
    flushH2DegradationRollups();
  } catch {
    // Flushing telemetry must never affect application shutdown.
  }

  if (inFlightDeliveries.size === 0) return;

  if (flushPromise) {
    await flushPromise;
    return;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const deliveries = Promise.allSettled([...inFlightDeliveries]).then(() => undefined);
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, Math.max(0, timeout));
    });
    flushPromise = Promise.race([deliveries, timeoutPromise]);
    await flushPromise;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    flushPromise = null;
  }
}

export function isSentryInitialized(): boolean {
  return sentryInitialized;
}
