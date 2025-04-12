import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Span } from "@opentelemetry/api";
import { v4 as uuidv4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { logger } from "../common/logger";
import { SpanManager } from "../instrumentation/span";

const spans = new Map<string, Span>();

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export class BlaxelMcpServerTransport implements Transport {
  private spanManager = new SpanManager("blaxel-tracer");

  private port: number;
  private wss!: WebSocketServer;
  private clients: Map<string, { ws: WebSocket }> = new Map();

  onclose?: () => void;
  onerror?: (err: Error) => void;
  private messageHandler?: (msg: JSONRPCMessage, clientId: string) => void;
  onconnection?: (clientId: string) => void;
  ondisconnection?: (clientId: string) => void;

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this.messageHandler = handler
      ? (msg: JSONRPCMessage, clientId) => {
          if (!("id" in msg)) {
            return handler(msg);
          }
          return handler({
            ...msg,
            id: clientId + ":" + msg.id,
          });
        }
      : undefined;
  }

  constructor(port?: number) {
    this.port = port ?? parseInt(process.env.BL_SERVER_PORT ?? "8080", 10);
    this.wss = new WebSocketServer({ port: this.port });
  }

  async start(): Promise<void> {
    logger.info("Starting WebSocket Server on port " + this.port);
    this.wss.on("connection", (ws: WebSocket) => {
      const clientId = uuidv4();
      this.clients.set(clientId, {
        ws,
      });
      this.onconnection?.(clientId);

      ws.on("message", (data: Buffer) => {
        const msgSpan = this.spanManager.createSpan("message", {
          "mcp.client.id": clientId,
        });
        try {
          const msg = JSON.parse(data.toString()) as JSONRPCMessage;
          this.messageHandler?.(msg, clientId);
          if ("method" in msg && "id" in msg && "params" in msg) {
            msgSpan.setAttributes({
              "mcp.message.parsed": true,
              "mcp.method": msg.method,
              "mcp.messageId": msg.id,
              "mcp.toolName": msg.params?.name as string | undefined,
            });
            spans.set(clientId + ":" + msg.id, msgSpan);
          }

          // Handle msg.id safely
          const msgId = msg.id ? String(msg.id) : "";
          const [cId, parsedMsgId] = msgId.split(":");
          msg.id = parsedMsgId ? parseInt(parsedMsgId) : undefined;

          // Use optional chaining for safe access
          const client = this.clients.get(cId ?? "");
          if (client?.ws?.readyState === WebSocket.OPEN) {
            const msgSpan = spans.get(cId + ":" + (msg.id ?? ""));
            try {
              client.ws.send(JSON.stringify(msg));
              if (msgSpan) {
                msgSpan.setAttributes({
                  "mcp.message.response_sent": true,
                });
              }
            } catch (err) {
              if (msgSpan) {
                msgSpan.setStatus({ code: 2 }); // Error status
                msgSpan.recordException(err as Error);
              }
              throw err;
            } finally {
              if (msgSpan) {
                msgSpan.end();
              }
            }
          } else {
            this.clients.delete(cId);
            this.ondisconnection?.(cId);
          }
        } catch (err: unknown) {
          if (err instanceof Error) {
            msgSpan.setStatus({ code: 2 }); // Error status
            msgSpan.recordException(err);
            this.onerror?.(err);
          } else {
            this.onerror?.(
              new Error(`Failed to parse message: ${String(err)}`)
            );
          }
          msgSpan.end();
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
        this.ondisconnection?.(clientId);
      });

      ws.on("error", (err) => {
        this.onerror?.(err);
      });
    });
    return Promise.resolve();
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    const [cId, msgId] = msg.id ? String(msg.id).split(":") : [];
    msg.id = parseInt(msgId);
    const data = JSON.stringify(msg);
    const deadClients: string[] = [];

    if (cId) {
      // Send to specific client
      const client = this.clients.get(cId);
      if (client?.ws?.readyState === WebSocket.OPEN) {
        const msgSpan = spans.get(cId + ":" + msg.id);

        try {
          client.ws.send(data);
          if (msgSpan) {
            msgSpan.setAttributes({
              "mcp.message.response_sent": true,
            });
          }
        } catch (err) {
          if (msgSpan) {
            msgSpan.setStatus({ code: 2 }); // Error status
            msgSpan.recordException(err as Error);
          }
          throw err;
        } finally {
          if (msgSpan) {
            msgSpan.end();
          }
        }
      } else {
        this.clients.delete(cId);
        this.ondisconnection?.(cId);
      }
    }

    for (const [id, client] of this.clients.entries()) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        deadClients.push(id);
      }
    }
    // Cleanup dead clients
    deadClients.forEach((id) => {
      this.clients.delete(id);
      this.ondisconnection?.(id);
    });
    return Promise.resolve();
  }

  async broadcast(msg: JSONRPCMessage): Promise<void> {
    return this.send(msg);
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.clients.clear();
        resolve();
      });
    });
  }
}
