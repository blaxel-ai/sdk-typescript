
import { findFromCache } from "../cache/index.js";
import { Agent, getAgent } from "../client/index.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { startSpan } from '../telemetry/telemetry.js';

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
    getAgentMetadata(this.agentName).then((agent) => {
      return new URL(agent?.metadata?.url ?? "");
    });
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
      `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`
    );
  }

  get forcedUrl() {
    return getForcedUrl('function', this.agentName)
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

    const span = startSpan(this.agentName, {
      attributes: {
        "agent.name": this.agentName,
        "agent.args": JSON.stringify(input),
        "span.type": "agent.run",
      },
      isRoot: false,
    });

    try {
      const response = await this.call(this.url, input);
      span.setAttribute("agent.run.result", await response.text());
      return await response.text();
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (!this.fallbackUrl) {
          span.setAttribute("agent.run.error", err.stack as string);
          throw err;
        }
        try {
          const response = await this.call(this.fallbackUrl, input);
          span.setAttribute("agent.run.result", await response.text());
          return await response.text();
        } catch (err: unknown) {
          if (err instanceof Error) {
            span.setAttribute("agent.run.error", err.stack as string);
          }
          throw err;
        }
      }
      throw err;
    } finally {
      span.end();
    }
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
