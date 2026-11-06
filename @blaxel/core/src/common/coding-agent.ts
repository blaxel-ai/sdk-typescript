/**
 * Environment variables coding agents set for the commands they run, first
 * match wins, with the agent id the SDK reports. Ids match the Blaxel CLI's.
 */
const CODING_AGENTS: ReadonlyArray<readonly [env: string, id: string]> = [
  ["CLAUDECODE", "claude-code"],
  ["CODEX_THREAD_ID", "codex"],
  ["CODEX_SANDBOX", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["GEMINI_CLI", "gemini-cli"],
  ["QWEN_CODE", "qwen-code"],
  ["OPENCODE_TERMINAL", "opencode"],
  ["OPENCODE", "opencode"],
  ["GOOSE_TERMINAL", "goose"],
  ["AUGMENT_AGENT", "augment"],
];

/**
 * Agent names found in the generic `AI_AGENT` and `AGENT` variables, mapped to
 * the same ids. Any other `AI_AGENT` name is reported as "other".
 */
const CODING_AGENT_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  "cursor-cli": "cursor",
  "gemini-cli": "gemini-cli",
  gemini: "gemini-cli",
  "qwen-code": "qwen-code",
  opencode: "opencode",
  goose: "goose",
  augment: "augment",
  "augment-cli": "augment",
  crush: "crush",
  "github-copilot": "github-copilot",
  "github-copilot-cli": "github-copilot",
};

/** Every environment variable `detectCodingAgent` reads. */
export const CODING_AGENT_ENV_VARS: readonly string[] = [
  ...CODING_AGENTS.map(([name]) => name),
  "AI_AGENT",
  "AGENT",
];

function agentName(value: string | undefined): string {
  const name = value?.trim().toLowerCase() ?? "";
  // Claude Code sets AI_AGENT=claude-code_<version>_agent: keep the name.
  const end = name.search(/[_/@ ]/);
  return end > 0 ? name.slice(0, end) : name;
}

function knownAgentId(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CODING_AGENT_NAMES, name)
    ? CODING_AGENT_NAMES[name]
    : undefined;
}

/**
 * Id of the coding agent whose environment the SDK runs in, "other" for an
 * agent without a known name, or "" for none.
 */
export function detectCodingAgent(getenv: (name: string) => string | undefined): string {
  for (const [name, id] of CODING_AGENTS) {
    if (getenv(name)?.trim()) {
      return id;
    }
  }
  const name = agentName(getenv("AI_AGENT"));
  if (name) {
    return knownAgentId(name) ?? "other";
  }
  // AGENT is a generic name, so only a known agent name counts.
  return knownAgentId(agentName(getenv("AGENT"))) ?? "";
}
