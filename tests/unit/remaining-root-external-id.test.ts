import { describe, expect, it, vi } from "vitest";
import {
  listAgents,
  listFunctions,
  listIntegrationConnections,
  listJobs,
  listModels,
  listPolicies,
} from "../../@blaxel/core/src/client/index.js";

const externalId = "remaining-root-external-id";

describe("remaining root resource externalId list filters", () => {
  it.each([
    ["agents", listAgents, "/agents"],
    ["functions", listFunctions, "/functions"],
    ["integration connections", listIntegrationConnections, "/integrations/connections"],
    ["jobs", listJobs, "/jobs"],
    ["models", listModels, "/models"],
    ["policies", listPolicies, "/policies"],
  ])("passes externalId through %s list queries", async (_label, listFn, url) => {
    const get = vi.fn().mockResolvedValue({ data: { data: [], meta: { hasMore: false, total: 0 } } });
    const client = { get };

    await listFn({
      client,
      query: { externalId, limit: 1 },
      throwOnError: true,
    } as never);

    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        url,
        query: expect.objectContaining({ externalId }),
        throwOnError: true,
      }),
    );
  });
});
