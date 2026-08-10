import { createHash } from "node:crypto";

import {
  ResponseError,
  SandboxInstance,
  isGatewayError,
  type SandboxCreateConfiguration,
  type SandboxNetwork,
} from "@blaxel/core";
import {
  type SandboxBackend,
  type SandboxBackendCreateInput,
  type SandboxBackendHandle,
  type SandboxNetworkPolicy,
  type SandboxSession,
} from "eve/sandbox";

import { toBlaxelNetworkPolicy } from "./network-policy.js";
import { createBlaxelEveSession } from "./session.js";

const DEFAULT_BACKEND_NAME = "blaxel";
const DEFAULT_NAME_PREFIX = "eve";
const DEFAULT_IMAGE = "blaxel/ts-app:latest";
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_SANDBOX_NAME_LENGTH = 49;

export type BlaxelEveUseOptions = {
  readonly networkPolicy?: SandboxNetworkPolicy;
};

type BlaxelEveSandboxCreateOptions = Pick<
  SandboxCreateConfiguration,
  | "envs"
  | "expires"
  | "extraArgs"
  | "image"
  | "labels"
  | "lifecycle"
  | "memory"
  | "ports"
  | "region"
  | "ttl"
  | "volumes"
>;

export type BlaxelEveBackendOptions = BlaxelEveSandboxCreateOptions & {
  /** Stable eve backend name. Changing it invalidates persisted backend state. */
  readonly backendName?: string;
  /** Prefix used for deterministic Blaxel resource names. */
  readonly namePrefix?: string;
  /** Initial policy for new session sandboxes. */
  readonly networkPolicy?: SandboxNetworkPolicy;
  /** Maximum buffered stdout or stderr bytes for an unread process stream. */
  readonly processOutputBufferBytes?: number;
  /** Maximum time to wait for a cold sandbox image to accept commands. */
  readonly startupTimeoutMs?: number;
};

/** Create a first-party Blaxel implementation of eve's public SandboxBackend. */
export function blaxel(
  options: BlaxelEveBackendOptions = {},
): SandboxBackend<BlaxelEveUseOptions, BlaxelEveUseOptions> {
  const {
    backendName = DEFAULT_BACKEND_NAME,
    namePrefix = DEFAULT_NAME_PREFIX,
    networkPolicy,
    processOutputBufferBytes,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    ...sandboxOptions
  } = options;

  validateOptions({
    backendName,
    namePrefix,
    processOutputBufferBytes,
    startupTimeoutMs,
  });
  const normalizedPrefix = normalizeNamePrefix(namePrefix);
  const configurationIdentity = stableHash({
    sandboxOptions,
    networkPolicy: networkPolicy ?? "allow-all",
  });

  return {
    name: backendName,
    prewarm(input) {
      return Promise.reject(templatePrewarmUnsupported(input.templateKey));
    },
    async create(input) {
      try {
        if (input.templateKey !== null) {
          throw templatePrewarmUnsupported(input.templateKey);
        }
        const labels = resourceLabels("session", input.tags, sandboxOptions.labels);
        const existing = await findExistingSession(input);
        if (existing) {
          await SandboxInstance.updateMetadata(existing.metadata.name, { labels });
          if (networkPolicy !== undefined) await applyNetworkPolicy(existing, networkPolicy);
          return createHandle(existing, input.sessionKey);
        }

        const sessionName = resourceName(
          normalizedPrefix,
          "session",
          `${input.sessionKey}\0${configurationIdentity}`,
        );
        const sandbox = await SandboxInstance.createIfNotExists({
          ...sandboxOptions,
          image: sandboxOptions.image ?? DEFAULT_IMAGE,
          labels,
          name: sessionName,
          network: initialNetwork(networkPolicy),
        });
        try {
          await ensureBaseRuntime(sandbox, startupTimeoutMs);
        } catch (error) {
          await sandbox.delete().catch(() => undefined);
          throw error;
        }
        return createHandle(sandbox, input.sessionKey);
      } catch (error) {
        throw new Error(
          `Blaxel backend failed to open sandbox session "${input.sessionKey}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
    },
  };

  async function findExistingSession(
    input: SandboxBackendCreateInput,
  ): Promise<SandboxInstance | null> {
    const persistedName = readString(input.existingMetadata, "sandboxName");
    const deterministicName = resourceName(
      normalizedPrefix,
      "session",
      `${input.sessionKey}\0${configurationIdentity}`,
    );
    const names = [...new Set([persistedName, deterministicName].filter(Boolean))] as string[];
    for (const name of names) {
      const sandbox = await tryGetSandbox(name);
      if (sandbox) return sandbox;
    }
    return null;
  }

  function createHandle(
    sandbox: SandboxInstance,
    sessionKey: string,
  ): SandboxBackendHandle<BlaxelEveUseOptions> {
    const openProcessStreams = new Set<() => void>();
    const session = createBlaxelEveSession({
      id: sessionKey,
      processOutputBufferBytes,
      sandbox,
      registerProcessStream(close) {
        openProcessStreams.add(close);
        return () => openProcessStreams.delete(close);
      },
    });

    return {
      session,
      async useSessionFn(useOptions?: BlaxelEveUseOptions): Promise<SandboxSession> {
        if (useOptions?.networkPolicy !== undefined) {
          await applyNetworkPolicy(sandbox, useOptions.networkPolicy);
        }
        return session;
      },
      captureState() {
        return Promise.resolve({
          backendName,
          metadata: { sandboxName: sandbox.metadata.name },
          sessionKey,
        });
      },
      shutdown() {
        for (const close of openProcessStreams) close();
        openProcessStreams.clear();
        // Blaxel automatically suspends an idle sandbox and preserves its full state.
        return Promise.resolve();
      },
    };
  }
}

export { createBlaxelEveSession } from "./session.js";
export { toBlaxelNetworkPolicy } from "./network-policy.js";
export default blaxel;

async function applyNetworkPolicy(
  sandbox: SandboxInstance,
  policy: SandboxNetworkPolicy,
): Promise<void> {
  await SandboxInstance.updateNetwork(sandbox.metadata.name, {
    network: toBlaxelNetworkPolicy(policy),
  });
}

function initialNetwork(policy: SandboxNetworkPolicy | undefined): SandboxNetwork | undefined {
  return policy === undefined ? undefined : toBlaxelNetworkPolicy(policy);
}

async function ensureBaseRuntime(
  sandbox: SandboxInstance,
  startupTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let retryDelayMs = 500;
  for (;;) {
    try {
      const result = await sandbox.process.exec({
        command: "mkdir -p /workspace && command -v bash >/dev/null",
        waitForCompletion: true,
        workingDir: "/",
      });
      if (result.exitCode !== 0) {
        throw new Error("The Blaxel sandbox image must provide bash.");
      }
      return;
    } catch (error) {
      if (!isRetryableStartupError(error) || Date.now() >= deadline) throw error;
      const remainingMs = deadline - Date.now();
      await delay(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  }
}

async function tryGetSandbox(name: string): Promise<SandboxInstance | null> {
  try {
    return await SandboxInstance.get(name);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function resourceName(prefix: string, kind: "session", identity: string): string {
  const hashLength = MAX_SANDBOX_NAME_LENGTH - prefix.length - kind.length - 2;
  return `${prefix}-${kind}-${stableHash(identity).slice(0, hashLength)}`;
}

function resourceLabels(
  kind: "session",
  tags: Readonly<Record<string, string>> | undefined,
  configured: Record<string, string> | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {
    ...(configured ?? {}),
    "blaxel-integration": "eve",
    "eve-resource": kind,
  };
  for (const [key, value] of Object.entries(tags ?? {})) {
    labels[`eve-${normalizeLabel(key, 59)}`] = normalizeLabel(value, 63);
  }
  return labels;
}

function normalizeNamePrefix(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  if (!normalized) throw new Error("namePrefix must contain a letter or number");
  return normalized;
}

function normalizeLabel(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, maxLength) || "unknown";
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateOptions(input: {
  backendName: string;
  namePrefix: string;
  processOutputBufferBytes: number | undefined;
  startupTimeoutMs: number;
}): void {
  if (!input.backendName.trim()) throw new Error("backendName cannot be empty");
  normalizeNamePrefix(input.namePrefix);
  if (!Number.isFinite(input.startupTimeoutMs) || input.startupTimeoutMs <= 0) {
    throw new Error("startupTimeoutMs must be a positive finite number");
  }
  if (
    input.processOutputBufferBytes !== undefined &&
    (!Number.isInteger(input.processOutputBufferBytes) || input.processOutputBufferBytes <= 0)
  ) {
    throw new Error("processOutputBufferBytes must be a positive integer");
  }
}

function isRetryableStartupError(error: unknown): boolean {
  if (isGatewayError(error)) return true;
  return (
    error instanceof ResponseError &&
    error.status === 404 &&
    /WORKLOAD_UNAVAILABLE|currently not available/iu.test(error.message)
  );
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.code === 404 || candidate.code === "404" || candidate.status === 404 || candidate.statusCode === 404;
}

function templatePrewarmUnsupported(templateKey: string): Error {
  return new Error(
    `Blaxel eve template prewarming is not supported (template "${templateKey}"). ` +
      "Use a custom Blaxel image for reusable dependencies and files, omit eve bootstrap() " +
      "and agent/sandbox/workspace seed files, and perform one-time session setup in onSession().",
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const { message } = error as { message?: unknown };
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error object";
    }
  }
  return String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
