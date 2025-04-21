import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { FunctionSchema } from "../client/types.gen.js";
import { onLoad } from "../common/autoload.js";
import { env } from "../common/env.js";
import { getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import settings from "../common/settings.js";
import { SpanManager } from "../instrumentation/span.js";
import { BlaxelMcpClientTransport } from "../mcp/client.js";
import { Tool } from "./types.js";
import { schemaToZodSchema } from "./zodSchema.js";

const McpToolCache = new Map<string, McpTool>();
export class McpTool {
  private name: string;
  private client: ModelContextProtocolClient;
  private transport?: BlaxelMcpClientTransport;

  private timer?: NodeJS.Timeout;
  private ms: number;
  private startPromise?: Promise<void> | null;

  constructor(name: string, ms: number = 5000) {
    this.name = name;
    if (env.BL_CLOUD) {
      this.ms = 0;
    } else {
      this.ms = ms;
    }
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

  get internalUrl() {
    const hash = getGlobalUniqueHash(settings.workspace, "function", this.name);
    return new URL(
      `${settings.runInternalProtocol}://${hash}.${settings.runInternalHostname}`
    );
  }

  get forcedUrl() {
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    if (env[`BL_FUNCTION_${envVar}_URL`]) {
      return new URL(env[`BL_FUNCTION_${envVar}_URL`] as string);
    }
    return null;
  }

  get url() {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  get spanManager() {
    return new SpanManager("blaxel-tracer");
  }

  async start() {
    logger.debug(`MCP:${this.name}:start`);
    this.stopCloseTimer();
    logger.debug(`MCP:${this.name}:startPromise`, this.startPromise);
    this.startPromise = this.startPromise || (async () => {
      logger.debug(`MCP:${this.name}:startPromise:onLoad`);
      await onLoad();
      try {
        logger.debug(`MCP:${this.name}:Connecting`);
        this.transport = new BlaxelMcpClientTransport(
          this.url.toString(),
          settings.headers
        );
        await this.client.connect(this.transport);
        logger.debug(`MCP:${this.name}:Connected`);
      } catch (err) {
        if (err instanceof Error) {
          logger.error(err.stack);
        }
        if (!this.fallbackUrl) {
          throw err;
        }
        logger.debug(`MCP:${this.name}:Connecting to fallback`);
        this.transport = new BlaxelMcpClientTransport(
          this.fallbackUrl.toString(),
          settings.headers
        );
        await this.client.connect(this.transport);
        logger.debug(`MCP:${this.name}:Connected to fallback`);
      }
    })();
    return await this.startPromise;
  }

  async close() {
    logger.debug(`MCP:${this.name}:Close in ${this.ms}ms`);
    if (!this.ms) {
      delete this.startPromise;
      return this.client.close();
    }
    this.timer = setTimeout(() => {
      logger.debug(`MCP:${this.name}:CloseTimer`);
      delete this.startPromise;
      this.client.close().catch((err) => {
        if (err instanceof Error) {
          logger.error(err.stack);
        }
      });
    }, this.ms);
  }

  stopCloseTimer() {
    logger.debug(`MCP:${this.name}:StopCloseTimer`);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async listTools(): Promise<Tool[]> {
    const result = this.spanManager.createActiveSpan(
      this.name,
      {
        "span.type": "tool.list",
      },
      async (span) => {
        logger.debug(`MCP:${this.name}:Listing tools`);
        await this.start();
        const { tools } = (await this.client.listTools()) as {
          tools: Array<{
            name: string;
            description: string;
            inputSchema: FunctionSchema;
          }>;
        };
        logger.debug(`MCP:${this.name}:Listed tools result`, tools);
        await this.close();
        const result = tools.map((tool) => {
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: schemaToZodSchema(tool.inputSchema),
            originalSchema: tool.inputSchema,
            call: (input: Record<string, unknown> | undefined) => {
              return this.call(tool.name, input);
            },
          };
        });
        span.setAttribute("tool.list.result", JSON.stringify(result));
        return result;
      }
    );
    return result as Promise<Tool[]>;
  }

  async call(toolName: string, args: Record<string, unknown> | undefined) {
    const result = this.spanManager.createActiveSpan(
      this.name + "." + toolName,
      {
        "span.type": "tool.call",
        "tool.name": toolName,
        "tool.args": JSON.stringify(args),
      },
      async (span) => {
        try {
          logger.debug(
            `MCP:${this.name}:Tool calling`,
            toolName,
            JSON.stringify(args)
          );
          logger.debug(`MCP:${this.name}:Tool calling:start`);
          await this.start();
          logger.debug(`MCP:${this.name}:Tool calling:start2`);
          const result = await this.client.callTool({
            name: toolName,
            arguments: args,
          });
          logger.debug(`MCP:${this.name}:Tool calling:result`);
          await this.close();
          logger.debug(
            `MCP:${this.name}:Tool result`,
            toolName,
            JSON.stringify(args),
            // result
          );
          span.setAttribute("tool.call.result", JSON.stringify(result));
          return result;
        } catch (err: unknown) {
          if (err instanceof Error) {
            logger.error(err.stack);
          }
          throw err;
        }
      }
    );
    return result;
  }
}

export const getMcpTool = async (name: string): Promise<Tool[]> => {
  let tool = McpToolCache.get(name);
  if (!tool) {
    logger.debug(`MCP:${name}:Creating new tool`);
    tool = new McpTool(name);
    McpToolCache.set(name, tool);
  }
  return await tool.listTools();
};
