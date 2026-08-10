import { describe, expect, it } from "vitest";

import { toBlaxelNetworkPolicy } from "../../@blaxel/eve-sandbox/src/network-policy.js";

describe("Blaxel eve network policy", () => {
  it("maps coarse and domain policies", () => {
    expect(toBlaxelNetworkPolicy("allow-all")).toEqual({});
    expect(toBlaxelNetworkPolicy("deny-all")).toEqual({
      proxy: { allowedDomains: [], routing: [] },
    });
    expect(toBlaxelNetworkPolicy({ allow: ["github.com", "*.npmjs.org"] })).toEqual({
      proxy: {
        allowedDomains: ["github.com", "*.npmjs.org"],
        routing: [],
      },
    });
  });

  it("brokers transformed headers through write-only Blaxel proxy secrets", () => {
    const policy = toBlaxelNetworkPolicy({
      allow: {
        "api.example.com": [
          {
            transform: [
              { headers: { authorization: "Bearer secret", "x-tenant": "acme" } },
            ],
          },
        ],
      },
    });

    expect(policy.proxy?.allowedDomains).toEqual(["api.example.com"]);
    expect(policy.proxy?.routing).toEqual([
      {
        destinations: ["api.example.com"],
        headers: {
          authorization: "{{SECRET:eve-0-0-0-0}}",
          "x-tenant": "{{SECRET:eve-0-0-0-1}}",
        },
        secrets: {
          "eve-0-0-0-0": "Bearer secret",
          "eve-0-0-0-1": "acme",
        },
      },
    ]);
    expect(JSON.stringify(policy.proxy?.routing?.[0]?.headers)).not.toContain("Bearer secret");
  });

  it("rejects eve policies that Blaxel cannot enforce exactly", () => {
    expect(() =>
      toBlaxelNetworkPolicy({ allow: ["github.com"], subnets: { deny: ["10.0.0.0/8"] } }),
    ).toThrow(/subnet/);
    expect(() =>
      toBlaxelNetworkPolicy({
        allow: {
          "api.example.com": [{ match: { path: { exact: "/v1" } }, transform: [] }],
        },
      }),
    ).toThrow(/match condition/);
    expect(() =>
      toBlaxelNetworkPolicy({
        allow: { "api.example.com": [{ forwardURL: "https://proxy.example.com" }] },
      }),
    ).toThrow(/forward requests/);
  });
});
