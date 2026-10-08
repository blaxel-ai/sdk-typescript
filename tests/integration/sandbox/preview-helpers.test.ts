import { SandboxInstance } from "@blaxel/core";
import { expect, it } from "vitest";
import { defaultImage, defaultLabels, fetchWithRetry, uniqueName } from "./helpers.js";

it("creates and reuses private shorthand previews and expiry-capped tokens", async () => {
  const name = uniqueName("preview-helpers");
  let testFailed = false;
  try {
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: "us-was-1", memory: 512,
      ports: [{ target: 3000 }], labels: defaultLabels,
    });
    await sandbox.process.exec({
      command: 'node -e \'require("http").createServer((req,res)=>res.end("pm-523-ok")).listen(3000,"0.0.0.0")\'',
      waitForPorts: [3000],
    });
    const preview = await sandbox.previews.createIfNotExists({ port: 3000 });
    expect(preview.name).toBe("preview-3000");
    expect(preview.spec.public).toBe(false);
    expect(preview.spec.prefixUrl ?? "").toBe("");
    const token = await preview.tokens.createIfExpired();
    expect(token.value.length > 0).toBe(true);
    expect(token.name.length > 0).toBe(true);
    expect(Math.abs(Date.parse(token.expiresAt.toString()) - Date.now() - 86_400_000)).toBeLessThan(60_000);

    const denied = await fetchWithRetry(preview.url, { signal: AbortSignal.timeout(10_000) });
    await denied.arrayBuffer();
    expect(denied.status).toBe(401);
    const url = new URL(preview.url);
    url.searchParams.set("bl_preview_token", token.value);
    const allowed = await fetchWithRetry(url.toString(), { signal: AbortSignal.timeout(10_000) });
    // Boolean assertions avoid ever printing a credential-bearing URL/token.
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("pm-523-ok");

    const reusedPreview = await sandbox.previews.createIfNotExists({ port: 3000 });
    expect(reusedPreview.name === preview.name && reusedPreview.url === preview.url).toBe(true);
    const reused = await reusedPreview.tokens.createIfExpired();
    expect(reused.value === token.value && reused.name === token.name).toBe(true);
    const shorter = await preview.tokens.createIfExpired(new Date(Date.now() + 7_200_000), 60_000);
    expect(shorter.value !== token.value).toBe(true);
    expect(Date.parse(shorter.expiresAt.toString()) < Date.parse(token.expiresAt.toString())).toBe(true);
    const publicPreview = await sandbox.previews.create({ port: 3000, name: "named-public", public: true });
    expect(publicPreview.name).toBe("named-public");
    expect(publicPreview.spec.public).toBe(true);
    const full = await sandbox.previews.create({ metadata: { name: "full-model" }, spec: { port: 3000, public: false } });
    expect(full.name).toBe("full-model");
    await preview.tokens.delete(token.name);
    expect((await preview.tokens.list()).some(entry => entry.name === token.name)).toBe(false);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await SandboxInstance.delete(name).catch((error: unknown) => {
      if (!testFailed) throw error;
      // Keep the original setup/assertion failure while still reporting failed cleanup.
      console.error("Preview helper sandbox cleanup failed:", error);
    });
  }
}, 55_000);
