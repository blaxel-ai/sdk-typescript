import { findFromCache } from "../cache/index.js";
import { Agent, getAgent } from "../client/index.js";
import { env } from "../common/env.js";
import { getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import settings from "../common/settings.js";
import { SpanManager } from "../instrumentation/span.js";
class BlAgent {
  agentName: string;
  constructor(agentName: string) {
    this.agentName = agentName;
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    return new URL(
      `${settings.runUrl}/${settings.workspace}/agents/${this.agentName}`
    );
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(
      settings.workspace,
      "agent",
      this.agentName
    );
    return new URL(
      `${settings.runInternalProtocol}://${hash}}.${settings.runInternalHostname}`
    );
  }

  get forcedUrl() {
    const envVar = this.agentName.replace(/-/g, "_").toUpperCase();
    if (env[`BL_AGENT_${envVar}_URL`]) {
      return new URL(env[`BL_AGENT_${envVar}_URL`] as string);
    }
    return null;
  }

  get url() {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  async call(
    url: URL,
    input: Record<string, unknown> | string | undefined
  ): Promise<Response> {
    let body = input;
    if (typeof body != "string") {
      body = JSON.stringify(body);
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...settings.headers,
        "Content-Type": "application/json",
      },
      body,
    });
    return response;
  }

  async run(
    input: Record<string, unknown> | string | undefined
  ): Promise<string> {
    logger.debug(`Agent Calling: ${this.agentName}`);
    const spanManager = new SpanManager("blaxel-tracer");
    const result = await spanManager.createActiveSpan(
      this.agentName,
      "agent.run",
      {
        "agent.name": this.agentName,
        "agent.args": JSON.stringify(input),
      },
      async (span) => {
        try {
          const response = await this.call(this.url, input);
          span.setAttribute("agent.run.result", await response.text());
          return await response.text();
        } catch (err: unknown) {
          if (err instanceof Error) {
            logger.error(err.stack);
          } else {
            span.setAttribute("agent.run.error", "An unknown error occurred");
          }
          if (!this.fallbackUrl) {
            if (err instanceof Error) {
              span.setAttribute("agent.run.error", err.stack as string);
            } else {
              span.setAttribute("agent.run.error", "An unknown error occurred");
            }
            throw err;
          }
          try {
            const response = await this.call(this.fallbackUrl, input);
            span.setAttribute("agent.run.result", await response.text());
            return await response.text();
          } catch (err: unknown) {
            if (err instanceof Error) {
              span.setAttribute("agent.run.error", err.stack as string);
            } else {
              span.setAttribute("agent.run.error", "An unknown error occurred");
            }
            throw err;
          }
        } finally {
          span.end();
        }
      }
    );
    return result as string;
  }
}

export const blAgent = (agentName: string) => {
  return new BlAgent(agentName);
};

export const getAgentMetadata = async (
  agent: string
): Promise<Agent | null> => {
  const cacheData = await findFromCache("Agent", agent);
  if (cacheData) {
    return cacheData as Agent;
  }
  const { data } = await getAgent({
    path: {
      agentName: agent,
    },
  });
  return data || null;
};
