import { describe, expect, it } from "vitest";
import { detectCodingAgent } from "./coding-agent.js";

function detect(vars: Record<string, string>): string {
  return detectCodingAgent((name) => vars[name]);
}

describe("detectCodingAgent", () => {
  it("returns nothing outside a coding agent", () => {
    expect(detect({})).toBe("");
    expect(detect({ CLAUDECODE: "", AI_AGENT: "  " })).toBe("");
  });

  it.each([
    [{ CLAUDECODE: "1" }, "claude-code"],
    [{ CODEX_THREAD_ID: "thread" }, "codex"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ GEMINI_CLI: "1" }, "gemini-cli"],
    [{ QWEN_CODE: "1" }, "qwen-code"],
    [{ OPENCODE_TERMINAL: "1" }, "opencode"],
    [{ OPENCODE: "1", AGENT: "1" }, "opencode"],
    [{ GOOSE_TERMINAL: "1" }, "goose"],
    [{ AUGMENT_AGENT: "1" }, "augment"],
  ])("detects the marker %j", (vars, id) => {
    expect(detect(vars)).toBe(id);
  });

  it("prefers an agent-specific marker over the generic variables", () => {
    expect(detect({ AI_AGENT: "something-else", CODEX_SANDBOX: "seatbelt" })).toBe("codex");
  });

  it.each([
    ["claude-code_2-1-306_agent", "claude-code"],
    ["Cursor", "cursor"],
    ["crush", "crush"],
    ["github-copilot-cli", "github-copilot"],
    ["some-new-agent", "other"],
  ])("maps AI_AGENT=%j to %j", (value, id) => {
    expect(detect({ AI_AGENT: value })).toBe(id);
  });

  it("reads AGENT only for a known agent name", () => {
    expect(detect({ AGENT: "goose" })).toBe("goose");
    expect(detect({ AGENT: "1" })).toBe("");
    expect(detect({ AGENT: "build-runner" })).toBe("");
    expect(detect({ AGENT: "goose", AI_AGENT: "claude" })).toBe("claude-code");
  });

  it("never reports a free-form name", () => {
    expect(detect({ AI_AGENT: "Jane Doe's laptop" })).toBe("other");
    expect(detect({ AI_AGENT: "toString" })).toBe("other");
    expect(detect({ AGENT: "toString" })).toBe("");
  });
});
