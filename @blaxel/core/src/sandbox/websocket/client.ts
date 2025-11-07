import { v4 as uuidv4 } from "uuid";
import { getWebSocket } from "../../common/node.js";

export interface WebSocketMessage {
  id: string;
  operation: string;
  data: Record<string, any>;
}

export interface WebSocketResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  status?: number;
  stream?: boolean;
  done?: boolean;
}

export interface WebSocketClientOptions {
  url: string;
  headers?: Record<string, string>;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export class WebSocketClient {
  private ws: any = null;
  private WebSocketClass: any = null;
  private url: string;
  private headers: Record<string, string>;
  private reconnect: boolean;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private streamHandlers = new Map<string, { onData: (data: any) => void; onEnd: () => void }>();
  private isClosing = false;
  private connectionPromise: Promise<void> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private lastPongReceived = Date.now();

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.headers = options.headers || {};
    this.reconnect = options.reconnect ?? true;
    this.reconnectInterval = options.reconnectInterval ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.initializeConnection();
    return this.connectionPromise;
  }

  private async initializeConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get WebSocket class and connect
      void (async () => {
        try {
          // Get WebSocket class if not already loaded
          if (!this.WebSocketClass) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            this.WebSocketClass = await getWebSocket();
          }

          // Convert http/https URL to ws/wss
          let wsUrl = this.url;
          if (wsUrl.startsWith("http://")) {
            wsUrl = wsUrl.replace("http://", "ws://");
          } else if (wsUrl.startsWith("https://")) {
            wsUrl = wsUrl.replace("https://", "wss://");
          }

          // Add /ws endpoint if not present
          if (!wsUrl.endsWith("/ws")) {
            wsUrl = `${wsUrl}/ws`;
          }

          // Create WebSocket with headers (if supported by the environment)
          const wsOptions: any = {};
          if (Object.keys(this.headers).length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            wsOptions.headers = this.headers;
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
          this.ws = new this.WebSocketClass(wsUrl, wsOptions);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          resolve();
        };


        this.ws.onmessage = (event: any) => { // eslint-disable-line
          this.handleMessage(event);
        };


        this.ws.onerror = (error: any) => { // eslint-disable-line
          console.error("WebSocket error:", error);
          reject(new Error("WebSocket connection error"));
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.ws.onclose = () => {
          this.stopHeartbeat();
          this.connectionPromise = null;

          if (!this.isClosing && this.reconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.reconnectTimeout = setTimeout(() => {
              this.connect().catch(console.error);
            }, this.reconnectInterval);
            // Allow process to exit even if reconnect timeout is pending
            if (this.reconnectTimeout.unref) {
              this.reconnectTimeout.unref();
            }
          } else {
            // Reject all pending requests
            this.pendingRequests.forEach(({ reject }) => {
              reject(new Error("WebSocket connection closed"));
            });
            this.pendingRequests.clear();
          }
        };

          // Handle pong messages for heartbeat
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          if (typeof this.ws.on === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            this.ws.on('pong', () => {
              this.lastPongReceived = Date.now();
            });
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  private startHeartbeat(): void {
    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (this.ws && this.WebSocketClass && this.ws.readyState === this.WebSocketClass.OPEN) {
        // Check if we received a pong recently (within 60 seconds)
        if (Date.now() - this.lastPongReceived > 60000) {
          console.warn("WebSocket heartbeat timeout, closing connection");
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          this.ws.close();
          return;
        }

        // Send ping
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (typeof this.ws.ping === 'function') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          this.ws.ping();
        }
      }
    }, 30000);

    // Allow process to exit even if heartbeat interval is active
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleMessage(event: any): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const response: WebSocketResponse = JSON.parse(String(event.data));

      // Check if this is a streaming response
      if (response.stream) {
        const streamHandler = this.streamHandlers.get(response.id);
        if (streamHandler) {
          // Call the data handler with the response data
          streamHandler.onData(response.data);

          // If stream is done, call end handler and clean up
          if (response.done) {
            streamHandler.onEnd();
            this.streamHandlers.delete(response.id);
          }
        }
        return;
      }

      // Regular request-response handling
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.success) {
          pending.resolve(response.data);
        } else {
          pending.reject(new Error(response.error || "Unknown error"));
        }
      }
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
    }
  }

  async send<T = any>(operation: string, data: Record<string, any> = {}): Promise<T> {
    // Ensure we're connected
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!this.ws || !this.WebSocketClass || this.ws.readyState !== this.WebSocketClass.OPEN) {
      await this.connect();
    }

    return new Promise<T>((resolve, reject) => {
      const id = uuidv4();
      const message: WebSocketMessage = {
        id,
        operation,
        data,
      };

      // Store the promise handlers
      this.pendingRequests.set(id, { resolve, reject });

      // Set a timeout for the request (60 seconds)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 60000);

      // Send the message
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (this.ws && this.WebSocketClass && this.ws.readyState === this.WebSocketClass.OPEN) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.ws.send(JSON.stringify(message));
      } else {
        this.pendingRequests.delete(id);
        reject(new Error("WebSocket not connected"));
      }
    });
  }

  sendStream(
    operation: string,
    data: Record<string, any>,
    onData: (data: any) => void,
    onEnd: () => void
  ): string {
    // Ensure we're connected
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!this.ws || !this.WebSocketClass || this.ws.readyState !== this.WebSocketClass.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = uuidv4();
    const message: WebSocketMessage = {
      id,
      operation,
      data,
    };

    // Store the stream handlers
    this.streamHandlers.set(id, { onData, onEnd });

    // Send the message
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.ws.send(JSON.stringify(message));

    return id;
  }

  cancelStream(id: string): void {
    this.streamHandlers.delete(id);
  }

  close(): void {
    this.isClosing = true;
    this.reconnect = false;
    this.stopHeartbeat();

    // Clear reconnect timeout if any
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      // In Node.js (ws package), use terminate() to forcefully close the connection
      // This immediately closes the socket without waiting for the close handshake
      // In browser, terminate() doesn't exist, so we fall back to close()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof this.ws.terminate === 'function') {
        // Node.js ws package - force immediate close
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.ws.terminate();
      } else {
        // Browser WebSocket - graceful close
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.ws.close();
      }

      this.ws = null;
    }

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error("WebSocket client closed"));
    });
    this.pendingRequests.clear();
    this.connectionPromise = null;
  }

  get isConnected(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return this.ws !== null && this.WebSocketClass !== null && this.ws.readyState === this.WebSocketClass.OPEN;
  }
}

