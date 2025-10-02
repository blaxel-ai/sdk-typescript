import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { env } from "../common/env.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { authenticate } from "../index.js";
import { BlaxelMcpClientTransport } from "../mcp/client.js";
import { startSpan } from "../telemetry/telemetry.js";
import { Tool } from "./types.js";
import { schemaToZodSchema } from "./zodSchema.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FunctionSchema } from "./zodSchema.js";

const McpToolCache = new Map<string, McpTool>();

export type ToolOptions = {
  ms?: number;
  meta?: Record<string, unknown> | undefined;
  transport?: string
};

export class McpTool {
  private name: string;
  private type: string;
  private pluralType: string;
  private client: ModelContextProtocolClient;
  private transport?: BlaxelMcpClientTransport | StreamableHTTPClientTransport;

  private timer?: NodeJS.Timeout;
  private ms: number;
  private transportName?: string;
  private meta: Record<string, unknown> | undefined;
  private startPromise?: Promise<void> | null;

  constructor(name: string, options: ToolOptions | number = { ms: 5000 }) {
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
      this.ms = typeof options === "number" ? options : options.ms || 5000;
    }
    this.meta = (typeof options === "object" && options.meta) || undefined

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
        this.transport = await this.getTransport();
        await this.client.connect(this.transport);
        logger.debug(`MCP:${this.name}:Connected`);
      } catch (err) {
        if (err instanceof Error) {
          logger.error(`MCP ${this.name} connection failed: ${err.message}`, {
            error: err.message,
            stack: err.stack,
            mcpName: this.name,
            url: this.url
          });
        }
        if (!this.fallbackUrl) {
          throw err;
        }
        logger.debug(`MCP:${this.name}:Connecting to fallback`);
        this.transport = await this.getTransport(this.fallbackUrl);
        await this.client.connect(this.transport);
        logger.debug(`MCP:${this.name}:Connected to fallback`);
      }
    })();
    return await this.startPromise;
  }

  async close(now: boolean = false) {
    logger.debug(`MCP:${this.name}:Close in ${now ? 0 : this.ms}ms`);
    if (now || !this.ms) {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      delete this.startPromise;
      return this.client.close();
    }
    this.timer = setTimeout(() => {
      logger.debug(`MCP:${this.name}:CloseTimer`);
      delete this.startPromise;
      this.client.close().catch((err) => {
        if (err instanceof Error) {
          logger.error(`MCP ${this.name} close failed: ${err.message}`, {
            error: err.message,
            stack: err.stack,
            mcpName: this.name
          });
        }
      });
    }, now ? 0 : this.ms);
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
        _meta: this.meta
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
        logger.error(`MCP tool call failed: ${err.message}`, {
          error: err.message,
          stack: err.stack,
          mcpName: this.name,
          toolName,
          args: JSON.stringify(args)
        });
      }
      throw err;
    } finally {
      span.end();
    }
  }

  async getTransport(forcedUrl?: URL): Promise<BlaxelMcpClientTransport | StreamableHTTPClientTransport> {
    if (!this.transportName) {
      // Detect transport type dynamically by querying the function's endpoint
      try {
        const testUrl = (forcedUrl || this.url).toString();
        const response = await fetch(testUrl + "/", {
          method: "GET",
          headers: settings.headers,
        });
        const responseText = await response.text();

        if (responseText.toLowerCase().includes("websocket")) {
          this.transportName = "websocket";
        } else {
          this.transportName = "http-stream";
        }

        logger.debug(`Detected transport type for ${this.name}: ${this.transportName}`);
      } catch (error) {
        // Default to websocket if we can't determine the transport type
        logger.warn(`Failed to detect transport type for ${this.name}: ${error}. Defaulting to websocket.`);
        this.transportName = "websocket";
      }
    }

    const url = forcedUrl || this.url;
    if (this.transportName === "http-stream") {
      url.pathname = url.pathname + "/mcp";
      return new StreamableHTTPClientTransport(url, { requestInit: { headers: settings.headers } })
    } else {
      return new BlaxelMcpClientTransport(
        url.toString(),
        settings.headers,
        { retry: { max: 0 } }
      );
    }
  }
}

export const getMcpTool = async (name: string, options?: ToolOptions | number): Promise<Tool[]> => {
  let tool = McpToolCache.get(name);
  if (!tool) {
    logger.debug(`MCP:${name}:Creating new tool`);
    tool = new McpTool(name, options);
    McpToolCache.set(name, tool);
  }
  return await tool.listTools();
};
