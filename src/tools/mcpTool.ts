import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { FunctionSchema } from "../client/types.gen.js";
import { onLoad } from "../common/autoload.js";
import { env } from "../common/env.js";
import { logger } from "../common/logger.js";
import settings from "../common/settings.js";
import { SpanManager } from "../instrumentation/span.js";
import { BlaxelMcpClientTransport } from "../mcp/client.js";
import { Tool } from "./types.js";
import { schemaToZodSchema } from "./zodSchema.js";

const McpToolCache = new Map<string, McpTool>();

class McpTool {
  private name: string;
  private client: ModelContextProtocolClient;
  private timer?: NodeJS.Timeout;
  private ms: number;
  private refreshActionPromise?: Promise<void> | null;

  constructor(name: string, ms: number = 5000) {
    this.name = name;
    this.ms = ms;
    this.client = new ModelContextProtocolClient(
      {
        name: this.name,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    if (env[`BL_FUNCTION_${envVar}_URL`]) {
      return new URL(env[`BL_FUNCTION_${envVar}_URL`] as string);
    }
    return new URL(
      `${settings.runUrl}/${settings.workspace}/functions/${this.name}`
    );
  }

  get url() {
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    if (env[`BL_FUNCTION_${envVar}_URL`]) {
      return new URL(env[`BL_FUNCTION_${envVar}_URL`] as string);
    }
    if (env[`BL_FUNCTION_${envVar}_SERVICE_NAME`]) {
      return new URL(
        `https://${env[`BL_FUNCTION_${envVar}_SERVICE_NAME`]}.${
          settings.runInternalHostname
        }`
      );
    }
    return this.externalUrl;
  }

  async close() {
    logger.debug("CLOSING: mcp", this.name);
    delete this.refreshActionPromise;
    await this.client.close();
  }

  closeTimer() {
    logger.debug(`CLOSING TIMER: mcp ${this.name}`);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  setTimer() {
    logger.debug(`SETTING TIMER: mcp ${this.name} ${this.ms}`);
    this.closeTimer();
    this.timer = setTimeout(() => {
      this.close().catch((err: Error) => {
        logger.error(err.stack);
      });
    }, this.ms);
  }

  async refreshAction() {
    await onLoad();
    logger.debug(`REFRESHING: mcp ${this.name}`);
    try {
      const transport = new BlaxelMcpClientTransport(
        this.url.toString(),
        settings.headers
      );
      await this.client.connect(transport);
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(err.stack);
      } else {
        logger.error("An unknown error occurred");
      }
      if (!this.fallbackUrl) {
        throw err;
      }
      const transport = new BlaxelMcpClientTransport(
        this.fallbackUrl.toString(),
        settings.headers
      );
      await this.client.connect(transport);
    }
  }

  async refresh() {
    this.closeTimer();
    this.refreshActionPromise =
      this.refreshActionPromise || this.refreshAction();
    return this.refreshActionPromise;
  }

  async listTools(): Promise<Tool[]> {
    logger.debug(`LISTING TOOLS: mcp ${this.name}`);
    await this.refresh();
    const { tools } = (await this.client.listTools()) as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: FunctionSchema;
      }>;
    };
    const result = tools.map((tool) => {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schemaToZodSchema(tool.inputSchema),
        call: (input: Record<string, unknown> | undefined) => {
          return this.call(tool.name, input);
        },
      };
    });
    this.setTimer();
    return result;
  }

  async call(toolName: string, args: Record<string, unknown> | undefined) {
    const spanManager = new SpanManager("blaxel-tracer");
    const result = spanManager.createActiveSpan(
      this.name + "." + toolName,
      {
        "tool.name": toolName,
        "tool.args": JSON.stringify(args),
      },
      async () => {
        logger.debug(
          `TOOLCALLING: mcp ${this.name} ${toolName} ${JSON.stringify(args)}`
        );
        await this.refresh();
        const result = await this.client.callTool({
          name: toolName,
          arguments: args,
        });
        logger.debug(
          `TOOLRESULT: mcp ${this.name} ${toolName} ${JSON.stringify(args)}`,
          result
        );
        this.setTimer();
        return result;
      }
    );
    return result;
  }
}

export const retrieveMCPClient = (name: string): McpTool => {
  if (McpToolCache.has(name)) {
    return McpToolCache.get(name) as McpTool;
  }
  const tool = new McpTool(name);
  McpToolCache.set(name, tool);
  return tool;
};

export const getMcpTool = async (name: string): Promise<Tool[]> => {
  const mcpClient = retrieveMCPClient(name);
  return await mcpClient.listTools();
};
