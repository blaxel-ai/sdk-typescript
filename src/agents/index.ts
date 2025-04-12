import { findFromCache } from "../cache/index.js";
import { Agent, getAgent } from "../client/index.js";
import { env } from "../common/env.js";
import { logger } from "../common/logger.js";
import settings from "../common/settings.js";
import { SpanManager } from "../instrumentation/span.js";
class BlAgent {
  agentName: string;
  constructor(agentName: string) {
    this.agentName = agentName;
  }

  get externalUrl() {
    return new URL(
      `${settings.runUrl}/${settings.workspace}/agents/${this.agentName}`
    );
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get url() {
    const envVar = this.agentName.replace(/-/g, "_").toUpperCase();
    if (env[`BL_AGENT_${envVar}_SERVICE_NAME`]) {
      return new URL(
        `https://${env[`BL_AGENT_${envVar}_SERVICE_NAME`]}.${
          settings.runInternalHostname
        }`
      );
    }
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
      {
        "agent.name": this.agentName,
        "agent.args": JSON.stringify(input),
      },
      async () => {
        try {
          const response = await this.call(this.url, input);
          return await response.text();
        } catch (err: unknown) {
          if (err instanceof Error) {
            logger.error(err.stack);
          } else {
            logger.error("An unknown error occurred");
          }
          if (!this.fallbackUrl) {
            throw err;
          }
          const response = await this.call(this.fallbackUrl, input);
          return await response.text();
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
