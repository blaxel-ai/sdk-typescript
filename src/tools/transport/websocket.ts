import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { logger } from "../../common/logger.js";
//const SUBPROTOCOL = "mcp";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Helper function to wait
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client transport for WebSocket: this will connect to a server over the WebSocket protocol.
 */
export class WebSocketClientTransport implements Transport {
  private _socket?: WebSocket;
  private _url: URL;
  private _headers: Record<string, string>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(url: URL, headers: Record<string, string>) {
    this._url = new URL(url.toString().replace("http", "ws"));
    this._headers = headers;
  }

  async start(): Promise<void> {
    if (this._socket) {
      throw new Error(
        "WebSocketClientTransport already started! If using Client class, note that connect() calls start() automatically."
      );
    }

    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        await this._connect();
        return;
      } catch (error) {
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
      this._socket = new WebSocket(this._url, {
        //protocols: SUBPROTOCOL,
        headers: this._headers,
      });
      this._socket.onerror = (event) => {
        const error =
          "error" in event
            ? (event.error as Error)
            : new Error(`WebSocket error: ${JSON.stringify(event)}`);
        reject(error);
        this.onerror?.(error);
      };

      this._socket.onopen = () => {
        logger.debug("WebSocket opened");
        resolve();
      };

      this._socket.onclose = () => {
        logger.debug("WebSocket closed");
        this.onclose?.();
        this._socket = undefined;
      };

      this._socket.onmessage = (event: WebSocket.MessageEvent) => {
        logger.debug("WebSocket message received");
        let message: JSONRPCMessage;
        try {
          message = JSONRPCMessageSchema.parse(
            JSON.parse(event.data.toString())
          );
        } catch (error) {
          logger.error(`Error parsing message: ${event.data}`);
          this.onerror?.(error as Error);
          return;
        }

        this.onmessage?.(message);
      };
    });
  }

  async close(): Promise<void> {
    this._socket?.close();
    this._socket = undefined;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
          if (!this._socket) {
            // Only try to start if socket doesn't exist
            await this.start();
          } else {
            throw new Error("WebSocket is not in OPEN state");
          }
        }

        await new Promise<void>((resolve, reject) => {
          try {
            this._socket?.send(JSON.stringify(message), (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          } catch (error) {
            reject(error);
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
