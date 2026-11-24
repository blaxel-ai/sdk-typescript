import { describe, expect, it } from "vitest";
import { authenticationErrorInterceptor } from "../../@blaxel/core/src/client/responseInterceptor.js";

const DOCS = "https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works";

describe("authenticationErrorInterceptor", () => {
  it("adds the authentication docs to a credential 403", async () => {
    const response = new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "denied" }), { status: 403 });
    const out = await authenticationErrorInterceptor(response);
    const json = (await out.json()) as { code?: string; documentation?: string };
    expect(json.code).toBe("UNAUTHORIZED");
    expect(json.documentation).toContain(DOCS);
  });

  it.each([
    ["a REQUEST_BLOCKED JSON body", JSON.stringify({ code: "REQUEST_BLOCKED", message: "Request blocked." }), {}],
    ["a nested REQUEST_BLOCKED envelope", JSON.stringify({ error: { code: "REQUEST_BLOCKED", message: "Request blocked." } }), {}],
    ["the edge's HTML block page", "<!DOCTYPE html><html><body>Request blocked.</body></html>", {}],
    ["the edge's plain-text block", "403 Request blocked", {}],
    ["the X-Blaxel-Error-Code header", "", { "X-Blaxel-Error-Code": "REQUEST_BLOCKED" }],
  ])("leaves an edge block alone: %s", async (_, body, headers) => {
    const response = new Response(body, { status: 403, headers });
    const out = await authenticationErrorInterceptor(response);
    expect(out).toBe(response);
    expect(await out.text()).not.toContain(DOCS);
  });
});
