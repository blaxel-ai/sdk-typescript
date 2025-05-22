import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";


// Type definitions for WebSocket environments
declare const globalThis: any;

// Detect environment
const isBrowser = typeof globalThis !== "undefined" && globalThis.window !== undefined;

// Type for WebSocket that works in both environments
interface UniversalWebSocket {
  readyState: number;
  close(): void;
  send(data: string, callback?: (error?: Error) => void): void;
  onerror?: ((event: any) => void) | null;
  onopen?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
}

// Conditional import for Node.js WebSocket
let NodeWebSocket: any;
if (!isBrowser) {
  try {
    // Dynamic import for Node.js environment
    NodeWebSocket = require("ws");
  } catch (error) {
    // ws is not available
  }
}

//const SUBPROTOCOL = "mcp";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Helper function to wait
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client transport for WebSocket: this will connect to a server over the WebSocket protocol.
 * Works in both browser and Node.js environments.
 */
export class BlaxelMcpClientTransport implements Transport {
  private _socket?: UniversalWebSocket;
  private _url: URL;
  private _headers: Record<string, string>;
  private _isBrowser: boolean;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(url: string, headers?: Record<string, string>) {
    this._url = new URL(url.replace("http", "ws"));
    this._headers = headers ?? {};
    this._isBrowser = isBrowser;
  }

  async start(): Promise<void> {
    if (this._socket) {
      throw new Error(
        "Blaxel already started! If using Client class, note that connect() calls start() automatically."
      );
    }

    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        await this._connect();
        return;
      } catch (error) {
        if (error instanceof Error) {
          logger.warn(error.stack ?? error.message);
        }
        attempts++;
        if (attempts === MAX_RETRIES) {
          throw error;
        }
        logger.debug(
          `WebSocket connection attempt ${attempts} failed, retrying in ${RETRY_DELAY_MS}ms...`
        );
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (this._isBrowser) {
          // Use native browser WebSocket
          const url = `${this._url.toString()}?token=${settings.token}`
          this._socket = new WebSocket(url) as UniversalWebSocket;
        } else {
          // Use Node.js WebSocket
          if (!NodeWebSocket) {
            throw new Error("WebSocket library not available in Node.js environment");
          }
          this._socket = new NodeWebSocket(this._url, {
            //protocols: SUBPROTOCOL,
            headers: this._headers,
          }) as UniversalWebSocket;
        }

        this._socket.onerror = (event) => {
          console.error(event)
          const error = this._isBrowser
            ? new Error(`WebSocket error: ${event.message}`)
            : "error" in event
            ? (event.error as Error)
            : new Error(`WebSocket error: ${event.message}`);
          reject(error);
          this.onerror?.(error);
        };

        this._socket.onopen = () => {
          resolve();
        };

        this._socket.onclose = () => {
          this.onclose?.();
          this._socket = undefined;
        };

        this._socket.onmessage = (event) => {
          let message: JSONRPCMessage;
          try {
            let dataString: string;
            if (this._isBrowser) {
              // Browser WebSocket MessageEvent
              const browserEvent = event as MessageEvent;
              dataString = typeof browserEvent.data === "string"
                ? browserEvent.data
                : browserEvent.data.toString();
            } else {
              // Node.js WebSocket MessageEvent
              const nodeEvent = event as import("ws").MessageEvent;
              if (typeof nodeEvent.data === "string") {
                dataString = nodeEvent.data;
              } else if (nodeEvent.data instanceof Buffer) {
                dataString = nodeEvent.data.toString("utf-8");
              } else {
                throw new Error("Unsupported data type for event.data");
              }
            }
            message = JSONRPCMessageSchema.parse(JSON.parse(dataString));
          } catch (error) {
            logger.error(
              `Error parsing message: ${
                typeof event.data === "object"
                  ? JSON.stringify(event.data)
                  : event.data
              }`
            );
            this.onerror?.(error as Error);
            return;
          }

          this.onmessage?.(message);
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("ws does not work in the browser")) {
          this._isBrowser = true;
          return this._connect().then(resolve).catch(reject);
        }
        reject(error as Error);
      }
    });
  }

    get isConnected() {
    if (!this._socket) return false;

    if (this._isBrowser) {
      return this._socket.readyState === 1; // WebSocket.OPEN = 1
    } else {
      return this._socket.readyState === 1; // WebSocket.OPEN = 1
    }
  }

  async close(): Promise<void> {
    this._socket?.close();
    this._socket = undefined;
    this.onclose?.();
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        if (!this._socket || !this.isConnected) {
          if (!this._socket) {
            // Only try to start if socket doesn't exist
            await this.start();
          } else {
            throw new Error("WebSocket is not in OPEN state");
          }
        }

        await new Promise<void>((resolve, reject) => {
          try {
            const messageStr = JSON.stringify(message);

            if (this._isBrowser) {
              // Browser WebSocket
              this._socket?.send(messageStr);
              resolve();
            } else {
              // Node.js WebSocket
              this._socket?.send(messageStr, (error?: Error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            }
          } catch (error: unknown) {
            reject(error as Error);
          }
        });
        return;
      } catch (error) {
        attempts++;
        if (attempts === MAX_RETRIES) {
          throw error;
        }
        logger.warn(
          `WebSocket send attempt ${attempts} failed, retrying in ${RETRY_DELAY_MS}ms...`
        );
        await delay(RETRY_DELAY_MS);
      }
    }
  }
}
