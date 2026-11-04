import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { SandboxInstance, settings, listSandboxes } from "@blaxel/core";
import type { SandboxConfiguration } from "@blaxel/core";
import { once } from "node:events";
import { connect, createServer } from "node:http2";
import type { ClientHttp2Session, ServerHttp2Session } from "node:http2";

// The build emits declarations separately from these internal runtime modules.
// Use source types while exercising the same compiled modules as the public SDK.
const { h2Pool } = await vi.importActual<
  typeof import("../../@blaxel/core/src/common/h2pool.js")
>("../../@blaxel/core/dist/esm/common/h2pool.js");

vi.mock("../../@blaxel/core/dist/esm/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, listSandboxes: vi.fn<typeof actual.listSandboxes>() };
});

const listSandboxesMock = vi.mocked(listSandboxes);

const makeSandbox = (name: string, region?: string): SandboxConfiguration => ({
  metadata: { name },
  spec: region ? { region } : {},
  status: "DEPLOYED",
});

function respondWith(sandboxes: SandboxConfiguration[]) {
  listSandboxesMock.mockResolvedValue({
    request: new Request("http://localhost/sandboxes"),
    response: new Response(),
    data: { data: sandboxes },
  });
}

describe("SandboxInstance.list() H2 session deduplication", () => {
  let h2GetSpy: MockInstance<typeof h2Pool.get>;
  let sessionA: ClientHttp2Session;
  let sessionB: ClientHttp2Session;
  const server = createServer();
  const serverSessions = new Set<ServerHttp2Session>();

  beforeAll(async () => {
    server.on("session", session => { serverSessions.add(session); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    sessionA = connect(origin);
    sessionB = connect(origin);
    await Promise.all([once(sessionA, "connect"), once(sessionB, "connect")]);
  });

  afterAll(async () => {
    sessionA?.destroy();
    sessionB?.destroy();
    for (const session of serverSessions) session.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    h2GetSpy = vi.spyOn(h2Pool, "get");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches the shared session to sandboxes in the same region", async () => {
    const sandboxes = Array.from({ length: 10 }, (_, i) =>
      makeSandbox(`sb-${i}`, "us-east-1"),
    );
    respondWith(sandboxes);
    h2GetSpy.mockResolvedValue(sessionA);

    const { data: instances } = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledWith(expect.stringContaining("us-east-1"));
    expect(instances).toHaveLength(10);
    for (const inst of instances) {
      expect(inst.h2Session).toBe(sessionA);
    }
  });

  it("attaches the matching shared session across two regions", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "us-east-1"),
      makeSandbox("sb-2", "eu-west-1"),
      makeSandbox("sb-3", "eu-west-1"),
      makeSandbox("sb-4", "us-east-1"),
    ];
    respondWith(sandboxes);
    h2GetSpy.mockImplementation((domain: string) => {
      if (domain.includes("us-east-1")) return Promise.resolve(sessionA);
      if (domain.includes("eu-west-1")) return Promise.resolve(sessionB);
      throw new Error(`Unexpected edge domain: ${domain}`);
    });

    const { data: instances } = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledWith(expect.stringContaining("us-east-1"));
    expect(h2GetSpy).toHaveBeenCalledWith(expect.stringContaining("eu-west-1"));
    expect(instances).toHaveLength(5);

    for (const inst of [instances[0], instances[1], instances[4]]) {
      expect(inst.h2Session).toBe(sessionA);
    }
    for (const inst of [instances[2], instances[3]]) {
      expect(inst.h2Session).toBe(sessionB);
    }
  });

  it("exposes the attached session and region domain", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "us-east-1"),
    ];
    respondWith(sandboxes);
    h2GetSpy.mockResolvedValue(sessionA);

    const { data: instances } = await SandboxInstance.list();

    for (const inst of instances) {
      expect(inst.h2Session).toBe(sessionA);
      expect(inst.h2Domain).toContain("us-east-1");
    }
  });

  it("skips sandboxes with no region gracefully", async () => {
    const sandboxes = [
      makeSandbox("sb-no-region"),
      makeSandbox("sb-with-region", "us-east-1"),
      makeSandbox("sb-no-region-2"),
    ];
    respondWith(sandboxes);
    h2GetSpy.mockResolvedValue(sessionA);

    const { data: instances } = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(3);
    expect(instances[0].h2Session).toBeNull();
    expect(instances[2].h2Session).toBeNull();
    expect(instances[1].h2Session).toBe(sessionA);
  });

  it("never calls h2Pool.get() when settings.disableH2 is true", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "eu-west-1"),
    ];
    respondWith(sandboxes);
    h2GetSpy.mockResolvedValue(sessionA);

    const original = settings.config.disableH2;
    settings.config.disableH2 = true;

    try {
      const { data: instances } = await SandboxInstance.list();

      expect(h2GetSpy).not.toHaveBeenCalled();
      expect(instances).toHaveLength(2);
      expect(instances[0].h2Session).toBeNull();
      expect(instances[1].h2Session).toBeNull();
    } finally {
      settings.config.disableH2 = original;
    }
  });
});
