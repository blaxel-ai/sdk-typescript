/**
 * Integration tests for programmatic SDK initialization.
 *
 * These tests hit the real Blaxel API and require credentials.
 * Set the following environment variables before running:
 *
 *   TEST_BL_WORKSPACE        - Blaxel workspace name
 *   TEST_BL_API_KEY          - API key (for apiKey test)
 *   TEST_BL_CLIENT_CREDS     - Base64-encoded client credentials (for string test)
 *   TEST_BL_CLIENT_ID        - Client ID (for object test)
 *   TEST_BL_CLIENT_SECRET    - Client secret (for object test)
 *
 * Run with:
 *   TEST_BL_WORKSPACE=... TEST_BL_API_KEY=... npx vitest --run src/common/initialize.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { listWorkspaces } from "../client/sdk.gen.js";
import { authenticate, initialize } from "./autoload.js";

const workspace = process.env.TEST_BL_WORKSPACE;

describe.runIf(workspace)("initialize() integration", () => {
  it("works with apiKey", async () => {
    const apiKey = process.env.TEST_BL_API_KEY;
    if (!apiKey) return;

    initialize({ workspace: workspace!, apiKey });

    const res = await listWorkspaces();
    expect(res.error).toBeUndefined();
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("works with clientCredentials as Base64 string", async () => {
    const clientCredentials = process.env.TEST_BL_CLIENT_CREDS;
    if (!clientCredentials) return;

    initialize({ workspace: workspace!, clientCredentials });
    await authenticate();

    const res = await listWorkspaces();
    expect(res.error).toBeUndefined();
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("works with clientCredentials as { clientId, clientSecret }", async () => {
    const clientId = process.env.TEST_BL_CLIENT_ID;
    const clientSecret = process.env.TEST_BL_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    initialize({
      workspace: workspace!,
      clientCredentials: { clientId, clientSecret },
    });
    await authenticate();

    const res = await listWorkspaces();
    expect(res.error).toBeUndefined();
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data)).toBe(true);
  });
});
