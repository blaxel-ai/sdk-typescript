import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getFunction, getSandbox } from "../client/index.js";
import { env } from "../common/env.js";
import { getForcedUrl } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { authenticate } from "../index.js";
import { startSpan } from "../telemetry/telemetry.js";
import { Tool } from "./types.js";
import { FunctionSchema, schemaToZodSchema } from "./zodSchema.js";

const McpToolCache = new Map<string, McpTool>();

export type ToolOptions = {
  ms?: number;
  meta?: Record<string, unknown> | undefined;
};

export class McpTool {
  private name: string;
  private type: string;
  private pluralType: string;
  private client: ModelContextProtocolClient;

  private timer?: NodeJS.Timeout;
  private ms: number;
  private meta: Record<string, unknown> | undefined;
  private startPromise?: Promise<void> | null;
  private metadataUrl?: string | null;

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
    this.meta = (typeof options === "object" && options.meta) || undefined;

    this.client = new ModelContextProtocolClient({
      name: this.name,
      version: "1.0.0",
    });
  }

  get forcedUrl(): URL | null {
    return getForcedUrl(this.type, this.name);
  }

  get externalUrl(): URL {
    return new URL(
      `${settings.runUrl}/${settings.workspace}/${this.pluralType}/${this.name}`
    );
  }

  private async fetchMetadataUrl(): Promise<string | null> {
    try {
      if (this.type === "sandbox") {
        const { data } = await getSandbox({ path: { sandboxName: this.name } });
        if (data?.metadata?.url) return data.metadata.url;
      } else {
        const { data } = await getFunction({ path: { functionName: this.name } });
        if (data?.metadata?.url) return data.metadata.url;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Failed to fetch metadata URL for ${this.name}: ${message}`);
    }
    return null;
  }

  private async resolveUrl(): Promise<URL> {
    if (this.forcedUrl) {
      logger.debug(`MCP:${this.name}:ForcedURL:${this.forcedUrl.toString()}`);
      return this.forcedUrl;
    }
    if (this.metadataUrl === undefined) {
      this.metadataUrl = await this.fetchMetadataUrl();
    }
    if (this.metadataUrl) {
      logger.debug(`MCP:${this.name}:MetadataURL:${this.metadataUrl}`);
      return new URL(this.metadataUrl);
    }
    logger.debug(`MCP:${this.name}:FallingBackToExternalURL:${this.externalUrl.toString()}`);
    return this.externalUrl;
  }

  async start() {
    logger.debug(`MCP:${this.name}:start`);
    this.stopCloseTimer();
    this.startPromise = this.startPromise || (async () => {
      await authenticate();
      const url = await this.resolveUrl();
      const mcpUrl = new URL(url.toString());
      mcpUrl.pathname = mcpUrl.pathname.replace(/\/$/, "") + "/mcp";
      logger.debug(`MCP:${this.name}:Connecting::${mcpUrl.toString()}`);
      const transport = new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: settings.headers },
      });
      await this.client.connect(transport);
      logger.debug(`MCP:${this.name}:Connected`);
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
            mcpName: this.name,
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
      logger.debug(`MCP:${this.name}:Tool calling`, toolName, JSON.stringify(args));
      await this.start();
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
        _meta: this.meta,
      });
      await this.close();
      span.setAttribute("tool.call.result", JSON.stringify(result));
      return result;
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(`MCP tool call failed: ${err.message}`, {
          error: err.message,
          stack: err.stack,
          mcpName: this.name,
          toolName,
          args: JSON.stringify(args),
        });
      }
      throw err;
    } finally {
      span.end();
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
