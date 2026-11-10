import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it, vi } from "vitest";
import { blModel } from "./model.js";
import { ChatBlaxelOpenAI } from "./model/openai.js";

const runtime = vi.hoisted(() => ({ type: "openai" as string | undefined }));

vi.mock("@blaxel/core", () => ({
  authenticate: vi.fn(),
  handleDynamicImportError: vi.fn(),
  settings: { headers: {} },
  getModelMetadata: vi.fn(() => ({
    metadata: { url: "https://gateway.example" },
    spec: { runtime: { generation: "mk3", ...runtime } },
  })),
}));

const tool = { type: "function", function: { name: "weather", parameters: {} } };
type Routable = { _useResponsesApi(options: unknown): boolean };
const usesResponses = (model: unknown, options?: unknown) => (model as Routable)._useResponsesApi(options);

describe("blModel mk3", () => {
  it("routes OpenAI tool calls to the Responses API and plain calls to Chat Completions", async () => {
    runtime.type = "openai";
    const model = await blModel("sandbox-openai");
    expect(model).toBeInstanceOf(ChatBlaxelOpenAI);
    expect(usesResponses(model, { tools: [tool] })).toBe(true);
    expect(usesResponses(model, {})).toBe(false);
    expect(usesResponses(model, undefined)).toBe(false);

    // bindTools goes through withConfig: the bound model must keep the routing.
    const bound = (model as ChatBlaxelOpenAI).bindTools([tool]);
    expect(bound).toBeInstanceOf(ChatBlaxelOpenAI);
    expect(usesResponses(bound, {})).toBe(true);
  });

  it("treats an mk3 model without runtime.type as OpenAI", async () => {
    runtime.type = undefined;
    const model = await blModel("sandbox-untyped");
    expect(model).toBeInstanceOf(ChatBlaxelOpenAI);
    expect(usesResponses(model, { tools: [tool] })).toBe(true);
  });

  it("keeps Chat Completions for non-OpenAI providers, even with tools", async () => {
    runtime.type = "anthropic";
    const model = await blModel("sandbox-anthropic");
    expect(model).not.toBeInstanceOf(ChatBlaxelOpenAI);
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(usesResponses(model, { tools: [tool] })).toBe(false);
  });
});
