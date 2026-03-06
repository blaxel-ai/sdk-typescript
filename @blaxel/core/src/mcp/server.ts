import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { v4 as uuidv4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { env } from "../common/env.js";
import { logger } from "../common/logger.js";

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export class BlaxelMcpServerTransport implements Transport {
  private port: number;
  private wss!: WebSocketServer;
  private clients: Map<string, { ws: WebSocket }> = new Map();

  onclose?: () => void;
  onerror?: (err: Error) => void;
  private messageHandler?: (msg: JSONRPCMessage, clientId: string) => void | Promise<void>;
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
    this.port = port ?? parseInt(env.BL_SERVER_PORT ?? "8080", 10);
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

      ws.on("message", async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JSONRPCMessage;
          await this.messageHandler?.(msg, clientId);

          // Handle msg.id safely
          const msgId = msg.id ? String(msg.id) : "";
          const [cId, parsedMsgId] = msgId.split(":");
          msg.id = parsedMsgId ? parseInt(parsedMsgId) : undefined;

          // Use optional chaining for safe access
          const client = this.clients.get(cId ?? "");
          if (client?.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
          } else {
            this.clients.delete(cId);
            this.ondisconnection?.(cId);
          }
        } catch (err: unknown) {
          if (err instanceof Error) {
            this.onerror?.(err);
          } else {
            this.onerror?.(
              new Error(`Failed to parse message: ${String(err)}`)
            );
          }
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
        client.ws.send(data);
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
