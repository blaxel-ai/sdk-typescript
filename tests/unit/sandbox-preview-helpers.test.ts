import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preview, PreviewToken, SandboxPreviewCreateConfiguration } from "@blaxel/core";

type Client = typeof import("../../@blaxel/core/src/client/index.js");
const { create, get, mint, list, remove } = vi.hoisted(() => ({
  create: vi.fn<Client["createSandboxPreview"]>(),
  get: vi.fn<Client["getSandboxPreview"]>(),
  mint: vi.fn<Client["createSandboxPreviewToken"]>(),
  list: vi.fn<Client["listSandboxPreviewTokens"]>(),
  remove: vi.fn<Client["deleteSandboxPreviewToken"]>(),
}));
// Exercise the built package; source signatures supply types for its JS client mocks.
vi.mock("../../@blaxel/core/dist/esm/client/index.js", async (importOriginal) => ({
  ...await importOriginal<Client>(),
  createSandboxPreview: create, getSandboxPreview: get,
  createSandboxPreviewToken: mint, listSandboxPreviewTokens: list, deleteSandboxPreviewToken: remove,
}));
import { SandboxPreview, SandboxPreviews, SandboxPreviewToken, SandboxPreviewTokens } from "@blaxel/core";
const preview: Preview = { metadata: { name: "app", resourceName: "sandbox" }, spec: { port: 3000, public: false, url: "https://app.example" } };
const previews = (name = "sandbox") => new SandboxPreviews({ metadata: { name }, spec: {} });
const now = Date.parse("2026-10-05T12:00:00Z");
const rawToken = (name: string, hours: number, spec = {}): PreviewToken => ({ metadata: { name }, spec: { token: name, expiresAt: new Date(now + hours * 3_600_000).toISOString(), ...spec } });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  create.mockResolvedValue({ data: preview } as never);
  mint.mockResolvedValue({ data: rawToken("new", 24) } as never);
  list.mockResolvedValue({ data: [] } as never);
  remove.mockResolvedValue({ data: {} } as never);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("preview shorthand", () => {
  it("exports the type and maps defaults identically in different sandboxes", async () => {
    const input: SandboxPreviewCreateConfiguration = { port: 3000 };
    await previews().create(input);
    await previews("other").create(input);
    expect(create).toHaveBeenNthCalledWith(1, { path: { sandboxName: "sandbox" }, query: {}, body: { metadata: { name: "preview-3000" }, spec: { port: 3000, public: false } }, throwOnError: true });
    expect(create.mock.calls[1][0]?.body).toEqual(create.mock.calls[0][0]?.body);
    expect(create.mock.calls[1][0]?.path).toEqual({ sandboxName: "other" });
  });
  it("maps explicit name/public/force and preserves legacy mixed input", async () => {
    await previews().create({ port: 3000, name: "named", public: true }, true);
    expect(create.mock.calls[0][0]).toMatchObject({ query: { force: "true" }, body: { metadata: { name: "named" }, spec: { port: 3000, public: true } } });
    const full = { ...preview, port: 0, public: "invalid" };
    await previews().create(full, true);
    expect(create.mock.calls[1][0]?.body).toBe(full);
  });
  it.each([
    [{ port: 0 }, "Preview port must be an integer between 1 and 65535"],
    [{ port: 65536 }, "Preview port must be an integer between 1 and 65535"],
    [{ port: 3.5 }, "Preview port must be an integer between 1 and 65535"],
    [{ port: NaN }, "Preview port must be an integer between 1 and 65535"],
    [{ port: true }, "Preview port must be an integer between 1 and 65535"],
    [{ port: 3000, name: "" }, "Preview name must be a nonempty string"],
    [{ port: 3000, name: null }, "Preview name must be a nonempty string"],
    [{ port: 3000, public: "false" }, "Preview public must be a boolean"],
  ])("validates before any HTTP: %j", async (input, message) => {
    await expect(previews().create(input as SandboxPreviewCreateConfiguration)).rejects.toThrow(new RangeError(message));
    await expect(previews().createIfNotExists(input as SandboxPreviewCreateConfiguration)).rejects.toThrow(new RangeError(message));
    expect(create).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it("returns a hit as-is, including public/different-port previews", async () => {
    get.mockResolvedValue({ data: { ...preview, spec: { public: true, port: 9999 } } } as never);
    const result = await previews().createIfNotExists({ port: 3000 });
    expect(result.spec).toEqual({ public: true, port: 9999 }); expect(create).not.toHaveBeenCalled();
  });
  it.each([{ code: 404 }, { status: 404, code: "NOT_FOUND" }, { statusCode: 404 }, { response: { status: 404 } }])("creates on shorthand missing status %j", async error => {
    get.mockRejectedValue(error);
    await previews().createIfNotExists({ port: 3000 }, true);
    expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][0]?.query).toEqual({ force: "true" });
  });
  it("rereads a name-creation race once, and propagates failed reread", async () => {
    get.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({ data: preview } as never);
    create.mockRejectedValue({ status: 409 });
    expect((await previews().createIfNotExists({ port: 3000 })).url).toBe(preview.spec.url);
    expect(get).toHaveBeenNthCalledWith(2, { path: { sandboxName: "sandbox", previewName: "preview-3000" }, throwOnError: true });
    const failure = new Error("reread failed");
    get.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce(failure);
    await expect(previews().createIfNotExists({ port: 3000 })).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(4); expect(create).toHaveBeenCalledTimes(2);
  });
  it.each([{ status: 403, code: 404 }, { status: 429 }, { status: 500 }, { code: "404" }])("propagates get errors %j", async error => {
    get.mockRejectedValue(error);
    await expect(previews().createIfNotExists({ port: 3000 })).rejects.toBe(error);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([403, 429, 500])("propagates create status %s without reread", async status => {
    get.mockRejectedValue({ status: 404 }); create.mockRejectedValue({ status });
    await expect(previews().createIfNotExists({ port: 3000 })).rejects.toEqual({ status });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("does not widen the legacy full-model race/error behavior", async () => {
    get.mockRejectedValue({ status: 404 });
    await expect(previews().createIfNotExists(preview)).rejects.toEqual({ status: 404 });
    expect(create).not.toHaveBeenCalled();
    get.mockRejectedValue({ code: 404 }); create.mockRejectedValue({ code: 409 });
    await expect(previews().createIfNotExists(preview, true)).rejects.toEqual({ code: 409 });
    expect(create.mock.calls[0][0]?.body).toBe(preview); expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("preview getters and reusable tokens", () => {
  const tokens = () => new SandboxPreviewTokens(preview);
  it("getters need no I/O; token name can be deleted", async () => {
    expect(new SandboxPreview(preview).url).toBe("https://app.example");
    for (const spec of [undefined, null, {}, { url: null }]) expect(new SandboxPreview({ metadata: { name: "app" }, spec } as unknown as Preview).url).toBe("");
    for (const metadata of [undefined, null, {}, { name: null }]) expect(new SandboxPreviewToken({ metadata, spec: {} } as unknown as PreviewToken).name).toBe("");
    const token = new SandboxPreviewToken(rawToken("generated", 2));
    expect(token.value).toBe("generated"); expect(token.expired).toBe(false);
    await tokens().delete(token.name);
    expect(remove.mock.calls[0][0]?.path?.tokenName).toBe("generated");
    expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it("creates once from an empty list with exactly default expiry; never deletes", async () => {
    expect((await tokens().createIfExpired()).name).toBe("new");
    expect(list.mock.calls[0][0]).toEqual({ path: { sandboxName: "sandbox", previewName: "app" }, throwOnError: true });
    expect(mint.mock.calls[0][0]?.body?.spec?.expiresAt).toBe(new Date(now + 86_400_000).toISOString());
    expect(mint).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
  });
  it("creates exactly once when the only token expires before minimum validity", async () => {
    list.mockResolvedValue({ data: [rawToken("short", 0.5)] } as never);
    expect((await tokens().createIfExpired()).name).toBe("new");
    expect(list).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0][0]?.body?.spec?.expiresAt).toBe(new Date(now + 86_400_000).toISOString());
    expect(remove).not.toHaveBeenCalled();
  });
  it("scans raw entries, skips all invalid credentials and chooses latest with stable ties", async () => {
    list.mockResolvedValue({ data: [null, {}, { spec: {} }, rawToken("empty", 4, { token: "" }), rawToken("bad", 4, { expiresAt: "bad" }), rawToken("missing", 4, { expiresAt: undefined }), rawToken("expired", 4, { expired: true }), rawToken("past", -1), rawToken("short", 0.5), rawToken("ceiling", 25), rawToken("first", 3), rawToken("tie", 3), rawToken("earlier", 2)] } as never);
    expect((await tokens().createIfExpired()).value).toBe("first");
    expect(mint).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it("accepts equal minimum/ceiling, but never expiry==now even with min=0", async () => {
    list.mockResolvedValueOnce({ data: [rawToken("equal", 1)] } as never);
    expect((await tokens().createIfExpired(new Date(now + 3_600_000), 3_600_000)).value).toBe("equal");
    list.mockResolvedValueOnce({ data: [rawToken("now", 0)] } as never);
    await tokens().createIfExpired(new Date(now + 1000), 0);
    expect(mint.mock.calls[0][0]?.body?.spec?.expiresAt).toBe(new Date(now + 1000).toISOString());
  });
  it("does not reuse a credential exceeding an explicit shorter expiry", async () => {
    list.mockResolvedValue({ data: [rawToken("long", 24)] } as never);
    await tokens().createIfExpired(new Date(now + 7_200_000), 1000);
    expect(mint.mock.calls[0][0]?.body?.spec?.expiresAt).toBe(new Date(now + 7_200_000).toISOString());
  });
  it.each([-1, NaN, Infinity, -Infinity])("rejects minValidity %s before I/O", async min => {
    await expect(tokens().createIfExpired(undefined, min)).rejects.toThrow(new RangeError("minValidity must be finite and non-negative"));
    expect(list).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled();
  });
  it.each([new Date(NaN), new Date(now), new Date(now - 1000), new Date(now + 1000)])("rejects invalid/short expiry %s before I/O", async expiry => {
    await expect(tokens().createIfExpired(expiry)).rejects.toThrow(new RangeError("expiresAt must be a valid future date at least minValidity from now"));
    expect(list).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled();
  });
  it("rejects explicitly public before I/O, but absent public defers to server", async () => {
    await expect(new SandboxPreviewTokens({ ...preview, spec: { public: true } }).createIfExpired()).rejects.toThrow("Cannot create or reuse a token for a public preview");
    expect(list).not.toHaveBeenCalled();
    await new SandboxPreviewTokens({ ...preview, spec: {} }).createIfExpired();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("rejects a non-list success and preserves list/create failures without retry", async () => {
    list.mockResolvedValueOnce({ data: {} } as never);
    await expect(tokens().createIfExpired()).rejects.toThrow("Failed to list preview tokens");
    const error = new Error("network failure"); list.mockRejectedValueOnce(error);
    await expect(tokens().createIfExpired()).rejects.toBe(error); expect(mint).not.toHaveBeenCalled();
    list.mockResolvedValueOnce({ data: [] } as never); mint.mockRejectedValueOnce(error);
    await expect(tokens().createIfExpired()).rejects.toBe(error);
    expect(list).toHaveBeenCalledTimes(3); expect(mint).toHaveBeenCalledTimes(1);
  });
});
