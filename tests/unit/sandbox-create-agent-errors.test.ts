import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so create/list can be scripted per test. sandbox.ts
// imports the same module ("../client/index.js"), so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), listSandboxes: vi.fn() };
});

import { createSandbox, listSandboxes } from "../../@blaxel/core/src/client/index.js";
import { CREATE_AUTH_RETRIES, SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);
const mockedList = vi.mocked(listSandboxes);

const created = (name = "agent-errors") =>
  ({ data: { metadata: { name }, spec: { runtime: {} }, status: "DEPLOYED" }, response: { status: 200 }, request: {} }) as never;

const failed = (status: number, error: Record<string, unknown>) =>
  ({ error, response: { status }, request: {} }) as never;

// The 403 body as it reaches create: the control plane's error plus the
// documentation link the authentication interceptor adds.
const authFailed = () =>
  failed(403, {
    code: "UNAUTHORIZED",
    message: "Authorization failed",
    status_code: 403,
    documentation: "For more information on authentication, visit: https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works",
  });

const authUnavailable = () =>
  failed(503, { code: "AUTHENTICATION_UNAVAILABLE", message: "Unable to verify credentials, please retry", status_code: 503 });

// Start a create and let its retry backoff (500ms then 1s, jitter zeroed) elapse.
async function createWithBackoff(config: Parameters<typeof SandboxInstance.create>[0], options = {}) {
  const pending = SandboxInstance.create(config, options).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  return pending;
}

describe("SandboxInstance.create on a transient authentication failure", () => {
  beforeEach(() => {
    // Keep edgeDomain null so create() skips the real H2 warm-up path.
    vi.stubEnv("BL_REGION", "");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
  });

  it("retries a 403 UNAUTHORIZED and resolves once the create goes through", async () => {
    mockedCreate.mockResolvedValueOnce(authFailed()).mockResolvedValueOnce(authFailed()).mockResolvedValueOnce(created());

    const { value, error } = await createWithBackoff({ name: "agent-errors" });

    expect(error).toBeUndefined();
    expect(value?.metadata.name).toBe("agent-errors");
    expect(mockedCreate).toHaveBeenCalledTimes(3);
  });

  it("retries a 503 AUTHENTICATION_UNAVAILABLE", async () => {
    mockedCreate.mockResolvedValueOnce(authUnavailable()).mockResolvedValueOnce(created());

    const { error } = await createWithBackoff({ name: "agent-errors" });

    expect(error).toBeUndefined();
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("waits with a backoff between attempts", async () => {
    mockedCreate.mockResolvedValueOnce(authFailed()).mockResolvedValueOnce(created());

    const pending = SandboxInstance.create({ name: "agent-errors" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded retries without claiming the key is invalid", async () => {
    mockedCreate.mockResolvedValue(authFailed());

    const { error } = await createWithBackoff({ name: "agent-errors" });

    expect(mockedCreate).toHaveBeenCalledTimes(CREATE_AUTH_RETRIES + 1);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status_code: 403 });
    const message = (error as { message: string }).message;
    expect(message).toMatch(/^Authorization failed \(HTTP 403 UNAUTHORIZED, after 3 attempts\)/);
    expect(message).toContain("both for a key it does not recognize and when its credential check fails");
    expect(message).toContain("if they are right, retry in a few seconds");
    expect(message).toContain("BL_API_KEY and BL_WORKSPACE");
    // The documentation link the interceptor added is kept.
    expect(error).toHaveProperty("documentation");
  });

  it("rethrows the original error once a 503 AUTHENTICATION_UNAVAILABLE persists", async () => {
    mockedCreate.mockResolvedValue(authUnavailable());

    const { error } = await createWithBackoff({ name: "agent-errors" });

    expect(mockedCreate).toHaveBeenCalledTimes(CREATE_AUTH_RETRIES + 1);
    expect(error).toEqual({ code: "AUTHENTICATION_UNAVAILABLE", message: "Unable to verify credentials, please retry", status_code: 503 });
  });

  it.each([
    [401, { code: "TOKEN_REVOKED", message: "Token has been revoked", status_code: 401 }],
    [403, { code: "UNAUTHORIZED_WORKSPACE", message: "You don't have write access to this workspace", status_code: 403 }],
    [403, { code: "QUOTA", message: "nope", status_code: 403 }],
    [409, { code: "ALREADY_EXISTS", message: "exists", status_code: 409 }],
    [503, { code: "SERVICE_UNAVAILABLE", message: "unavailable", status_code: 503 }],
  ])("does not retry a final %i %o", async (status, body) => {
    mockedCreate.mockResolvedValue(failed(status, body));

    const { error } = await createWithBackoff({ name: "agent-errors" });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(error).toEqual(body);
  });

  it("retries the same way for createIfNotExists", async () => {
    mockedCreate.mockResolvedValueOnce(authFailed()).mockResolvedValueOnce(created());

    const pending = SandboxInstance.createIfNotExists({ name: "agent-errors" });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(mockedCreate).toHaveBeenCalledTimes(2);
    for (const [call] of mockedCreate.mock.calls) {
      expect(call.query).toEqual({ createIfNotExist: true });
    }
  });
});

describe("SandboxInstance.create with an invalid name", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
  });

  it("sends the name unchanged", async () => {
    mockedCreate.mockResolvedValueOnce(created("sesn_01AbC"));

    await SandboxInstance.create({ name: "sesn_01AbC" });

    expect(mockedCreate.mock.calls[0][0].body?.metadata.name).toBe("sesn_01AbC");
  });

  it("adds the naming rule and the sanitized name to the 400", async () => {
    const message = "metadata.name must contain only lower case alphanumeric characters and hyphens";
    mockedCreate.mockResolvedValueOnce(failed(400, { code: "BAD_REQUEST", message, status_code: 400 }));

    const error = await SandboxInstance.create({ name: "sesn_01AbC" }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "BAD_REQUEST", status_code: 400 });
    const text = (error as { message: string }).message;
    expect(text.startsWith(`${message}. Sandbox names use`)).toBe(true);
    expect(text).toContain("lowercase letters, digits and single hyphens");
    expect(text).toContain('sanitizeSandboxName("sesn_01AbC") gives "sesn-01abc"');
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves a 400 for a valid name as it is", async () => {
    const body = { code: "BAD_REQUEST", message: "invalid memory", status_code: 400 };
    mockedCreate.mockResolvedValueOnce(failed(400, body));

    const error = await SandboxInstance.create({ name: "valid-name" }).catch((e: unknown) => e);

    expect(error).toEqual(body);
  });
});

describe("SandboxInstance.create on a limit or an edge block", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
  });

  const rejected = (status: number, error: unknown, headers: Record<string, string> = {}) =>
    ({ error, response: { status, headers: new Headers(headers) }, request: {} }) as never;

  it("says a 429 QUOTA_EXCEEDED is not retryable and links the quotas page", async () => {
    const body = { code: "QUOTA_EXCEEDED", message: "Sandbox quota exceeded", status_code: 429 };
    mockedCreate.mockResolvedValueOnce(rejected(429, body, { "Retry-After": "5" }));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", status_code: 429, retryable: false });
    expect((error as { message: string }).message).toBe(
      "Sandbox quota exceeded (HTTP 429 QUOTA_EXCEEDED: not retryable until quota is freed or raised: https://docs.blaxel.ai/Security/Quotas)",
    );
  });

  it("says a 429 WORKSPACE_RATE_LIMIT_EXCEEDED is retryable after the Retry-After delay", async () => {
    const body = { code: "WORKSPACE_RATE_LIMIT_EXCEEDED", message: "Too many sandbox creations", status_code: 429 };
    mockedCreate.mockResolvedValueOnce(rejected(429, body, { "Retry-After": "7" }));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "WORKSPACE_RATE_LIMIT_EXCEEDED", retryable: true, retry_after: 7 });
    expect((error as { message: string }).message).toBe(
      "Too many sandbox creations (HTTP 429 WORKSPACE_RATE_LIMIT_EXCEEDED: too many creations in flight in this workspace; retry after 7 s)",
    );
  });

  it("says to back off on a WORKSPACE_RATE_LIMIT_EXCEEDED without Retry-After", async () => {
    const body = { code: "WORKSPACE_RATE_LIMIT_EXCEEDED", message: "Too many sandbox creations", status_code: 429 };
    mockedCreate.mockResolvedValueOnce(rejected(429, body));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(error).not.toHaveProperty("retry_after");
    expect((error as { message: string }).message).toMatch(/in flight in this workspace; retry with backoff\)$/);
  });

  it.each([
    ["the body the auth interceptor leaves", "\nFor more information on authentication, visit: https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works"],
    ["an empty object", {}],
    ["an empty JSON object the auth interceptor annotated", { documentation: "For more information on authentication, visit: https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works" }],
    ["an HTML error page from the edge", "<!DOCTYPE HTML><HTML><BODY><H1>403 ERROR</H1>Generated by cloudfront (CloudFront)</BODY></HTML>"],
  ])("says a 403 without a JSON error body was likely blocked before the API (%s)", async (_, error) => {
    mockedCreate.mockResolvedValueOnce(rejected(403, error));

    const thrown = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(thrown).toEqual({
      message:
        "HTTP 403 without a JSON error body: likely an edge rate limit or firewall block in front of the API. " +
        "If you send many requests, slow down and retry after about 60 s. " +
        "Blaxel quota and permission errors carry a JSON error code",
      status_code: 403,
    });
  });

  it("keeps a JSON 403 from the API as is", async () => {
    const body = { code: "UNAUTHORIZED_WORKSPACE", message: "no write access", status_code: 403 };
    mockedCreate.mockResolvedValueOnce(rejected(403, body));

    const thrown = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(thrown).toEqual(body);
  });

  it("prefers the retry_after the API sends over the header", async () => {
    const body = { code: "WORKSPACE_RATE_LIMIT_EXCEEDED", message: "Too many sandbox creations", status_code: 429, retryable: true, retry_after: 4 };
    mockedCreate.mockResolvedValueOnce(rejected(429, body, { "Retry-After": "9" }));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(error).toMatchObject({ retryable: true, retry_after: 4 });
    expect((error as { message: string }).message).toMatch(/retry after 4 s\)$/);
  });

  it("says a 429 RATE_LIMIT_EXCEEDED is retryable", async () => {
    const body = { code: "RATE_LIMIT_EXCEEDED", message: "rate limit exceeded", status_code: 429 };
    mockedCreate.mockResolvedValueOnce(rejected(429, body));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "RATE_LIMIT_EXCEEDED", retryable: true });
    expect((error as { message: string }).message).toBe(
      "rate limit exceeded (HTTP 429 RATE_LIMIT_EXCEEDED: the region's creation rate limit was reached; retry with backoff)",
    );
  });

  it("says a 400 QUOTA_EXCEEDED for one volume is not retryable as is", async () => {
    const message = "Ephemeral volume 'scratch' size 900000 MB exceeds maximum allowed size";
    const body = { code: "QUOTA_EXCEEDED", message, status_code: 400 };
    mockedCreate.mockResolvedValueOnce(rejected(400, body));

    const error = await SandboxInstance.create({ name: "agent-errors" }).catch((e: unknown) => e);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", status_code: 400, retryable: false });
    expect((error as { message: string }).message).toBe(
      `${message} (HTTP 400 QUOTA_EXCEEDED: not retryable as is; request a smaller volume or raise the quota: https://docs.blaxel.ai/Security/Quotas)`,
    );
  });
});

describe("SandboxInstance.create without a region", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // The notice is once per process: load a fresh copy of the module each time.
  async function freshModule() {
    vi.resetModules();
    const client = await import("../../@blaxel/core/src/client/index.js");
    const { SandboxInstance: Fresh } = await import("../../@blaxel/core/src/sandbox/sandbox.js");
    const create = vi.mocked(client.createSandbox);
    create.mockReset();
    create.mockResolvedValue(created());
    return { Fresh, create };
  }

  const regionNotices = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls
      .map(([text]) => text)
      .filter((text): text is string => typeof text === "string" && text.includes("no region set"));

  it("says once per process that the platform picks the region", async () => {
    vi.stubEnv("BL_REGION", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { Fresh } = await freshModule();

    await Fresh.create({ name: "agent-errors" });
    await Fresh.create({ name: "agent-errors" });
    await Fresh.create({ name: "agent-errors" });

    const notices = regionNotices(warn);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("BL_REGION");
    expect(notices[0]).toContain("shown once per process");
  });

  it("says nothing when the region comes from the config or BL_REGION", async () => {
    vi.stubEnv("BL_REGION", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { Fresh, create } = await freshModule();
    // Keep the H2 warm-up out of the way of a regioned create.
    vi.stubEnv("BL_DISABLE_H2", "true");

    await Fresh.create({ name: "agent-errors", region: "us-pdx-1" });
    vi.stubEnv("BL_REGION", "eu-lon-1");
    await Fresh.create({ name: "agent-errors" });

    expect(regionNotices(warn)).toHaveLength(0);
    expect(create.mock.calls[1][0].body?.spec?.region).toBe("eu-lon-1");
  });
});

describe("SandboxInstance.list on an empty workspace", () => {
  afterEach(() => {
    mockedList.mockReset();
  });

  it.each([[[]], [{ data: [], meta: { hasMore: false } }], [{}], [{ data: null }], [undefined]])(
    "returns an empty page for %j",
    async (body) => {
      mockedList.mockResolvedValueOnce({ data: body, response: { status: 200 }, request: {} } as never);

      const page = await SandboxInstance.list();

      expect(page.data).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(await page.autoPagingToArray({ limit: 10 })).toEqual([]);
    },
  );
});
