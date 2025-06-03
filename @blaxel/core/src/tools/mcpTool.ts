import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { FunctionSchema } from "../client/types.gen.js";
import { env } from "../common/env.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { authenticate } from "../index.js";
import { BlaxelMcpClientTransport } from "../mcp/client.js";
import { startSpan } from "../telemetry/telemetry.js";
import { Tool } from "./types.js";
import { schemaToZodSchema } from "./zodSchema.js";
const McpToolCache = new Map<string, McpTool>();
export class McpTool {
  private name: string;
  private type: string;
  private pluralType: string;
  private client: ModelContextProtocolClient;
  private transport?: BlaxelMcpClientTransport;

  private timer?: NodeJS.Timeout;
  private ms: number;
  private startPromise?: Promise<void> | null;

  constructor(name: string, ms: number = 5000) {
    this.name = name;
    this.type = "function";
    this.pluralType = "functions";
    if (name.startsWith("sandbox/") || name.startsWith("sandboxes/")) {
      this.name = name.split("/")[1];
      this.type = "sandbox";
      this.pluralType = "sandboxes";
    }
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
    return new URL(
      `${settings.runUrl}/${settings.workspace}/${this.pluralType}/${this.name}`
    );
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(settings.workspace, this.type, this.name);
    return new URL(
      `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`
    );
  }

  get forcedUrl() {
    return getForcedUrl(this.type, this.name)
  }

  get url() {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  async start() {
    logger.debug(`MCP:${this.name}:start`);
    this.stopCloseTimer();
    this.startPromise = this.startPromise || (async () => {
      await authenticate();
      try {
        logger.debug(`MCP:${this.name}:Connecting::${this.url.toString()}`);
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
    const span = startSpan(this.name, {
      attributes: {
        "span.type": "tool.list",
      },
    });
    try {
      logger.debug(`MCP:${this.name}:Listing tools`);
      await this.start();
      const { tools } = (await this.client.listTools()) as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: FunctionSchema;
        }>;
      };
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
    } catch (err) {
      span.setStatus("error");
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }

  async call(toolName: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const span = startSpan(this.name + "." + toolName, {
      attributes: {
        "span.type": "tool.call",
        "tool.name": toolName,
        "tool.args": JSON.stringify(args),
      },
    });
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
    } finally {
      span.end();
    }
  }
}

export const getMcpTool = async (name: string, ms?: number): Promise<Tool[]> => {
  let tool = McpToolCache.get(name);
  if (!tool) {
    logger.debug(`MCP:${name}:Creating new tool`);
    tool = new McpTool(name, ms);
    McpToolCache.set(name, tool);
  }
  return await tool.listTools();
};
