import { Sandbox } from "../client/types.gen.js";
import { settings } from "../common/settings.js";
import { SandboxAction } from "./action.js";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, postProcess } from "./client/index.js";

export class SandboxProcess extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  public streamLogs(
    identifier: string,
    options: {
      ws?: boolean,
      onLog?: (log: string) => void,
      onStdout?: (stdout: string) => void,
      onStderr?: (stderr: string) => void,
    }
  ): { close: () => void } {
    if (options.ws) {
      return this.wsStreamLogs(identifier, options);
    }
    return this.sseStreamLogs(identifier, options);
  }

  public wsStreamLogs(
    identifier: string,
    options: {
      onLog?: (log: string) => void,
      onStdout?: (stdout: string) => void,
      onStderr?: (stderr: string) => void,
    }
  ): { close: () => void } {
    let closed = false;
    let ws: WebSocket | null = this.websocket(`process/${identifier}/logs/stream`)
    let pingInterval: NodeJS.Timeout | number | null = null;
    let pongTimeout: NodeJS.Timeout | number | null = null;
    const PING_INTERVAL_MS = 30000;
    const PONG_TIMEOUT_MS = 10000;

    function sendPing() {
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {}
        // Set pong timeout
        if (pongTimeout) clearTimeout(pongTimeout as any);
        pongTimeout = setTimeout(() => {
          // No pong received in time, close connection
          if (ws && typeof ws.close === 'function') ws.close();
        }, PONG_TIMEOUT_MS);
      }
    }

    if (ws) {
      ws.onmessage = (event: MessageEvent | { data: string }) => {
        if (closed) return;
        let data: any;
        try {
          data = typeof event.data === 'string' ? event.data : (event as any).data;
          if (!data) return;
          let payload: any;
          try {
            payload = JSON.parse(data);
          } catch {
            payload = { log: data };
          }
          // Handle ping/pong
          if (payload.type === 'ping') {
            // Respond to ping with pong
            if (ws && ws.readyState === ws.OPEN) {
              try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
            }
            return;
          }
          if (payload.type === 'pong') {
            // Pong received, clear pong timeout
            if (pongTimeout) clearTimeout(pongTimeout as any);
            pongTimeout = null;
            return;
          }
          if (payload.type === 'log') {
            const logLine = payload.log || "";
            if (typeof logLine === 'string') {
              if (logLine.startsWith('stdout:')) {
              options.onStdout?.(logLine.slice(7));
              options.onLog?.(logLine.slice(7));
            } else if (logLine.startsWith('stderr:')) {
              options.onStderr?.(logLine.slice(7));
              options.onLog?.(logLine.slice(7));
            } else {
              options.onLog?.(logLine);
              }
            }
          }
        } catch (err) {
          console.error('WebSocket log stream error:', err);
        }
      };
      ws.onerror = (err: any) => {
        closed = true;
        if (ws && typeof ws.close === 'function') ws.close();
      };
      ws.onclose = () => {
        closed = true;
        ws = null;
        if (pingInterval) clearInterval(pingInterval as any);
        if (pongTimeout) clearTimeout(pongTimeout as any);
      };
      // Start ping interval
      pingInterval = setInterval(sendPing, PING_INTERVAL_MS);
    }
    return {
      close: () => {
        closed = true;
        if (ws && typeof ws.close === 'function') ws.close();
        ws = null;
        if (pingInterval) clearInterval(pingInterval as any);
        if (pongTimeout) clearTimeout(pongTimeout as any);
      },
    };
  }

  public sseStreamLogs(
    identifier: string,
    options: {
      onLog?: (log: string) => void,
      onStdout?: (stdout: string) => void,
      onStderr?: (stderr: string) => void,
    }
  ): { close: () => void } {
    const controller = new AbortController();
    (async () => {
      try {
        const stream = await fetch(`${this.url}/process/${identifier}/logs/stream`, {
          method: 'GET',
          signal: controller.signal,
          headers: settings.headers,
        });

        if (stream.status !== 200) {
          throw new Error(`Failed to stream logs: ${await stream.text()}`);
        }
        if (!stream.body) throw new Error('No stream body');

        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split(/\r?\n/);
          buffer = lines.pop()!;
          for (const line of lines) {
            if (line.startsWith('stdout:')) {
              options.onStdout?.(line.slice(7));
              options.onLog?.(line.slice(7));
            } else if (line.startsWith('stderr:')) {
              options.onStderr?.(line.slice(7));
              options.onLog?.(line.slice(7));
            } else {
              options.onLog?.(line);
            }
          }
        }
      } catch (err: any) {
        if (err && err.name !== 'AbortError') {
          console.error("Stream error:", err);
          throw err;
        }
      }
    })();
    return {
      close: () => controller.abort(),
    };
  }

  async exec(process: ProcessRequest): Promise<PostProcessResponse> {
    const { response, data, error } = await postProcess({
      body: process,
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as PostProcessResponse;
  }

  async wait(identifier: string, {maxWait = 60000, interval = 1000}: {maxWait?: number, interval?: number} = {}): Promise<GetProcessByIdentifierResponse> {
    const startTime = Date.now();
    let status = "running";
    let data = await this.get(identifier);
    while (status === "running") {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        data = await this.get(identifier);
        status = data.status ?? "running";
      } catch {
        break;
      }
      if (Date.now() - startTime > maxWait) {
        throw new Error("Process did not finish in time");
      }
    }
    return data;
  }

  async get(identifier: string): Promise<GetProcessByIdentifierResponse> {
    const { response, data, error } = await getProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessByIdentifierResponse;
  }

  async list(): Promise<GetProcessResponse> {
    const { response, data, error } = await getProcess({
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessResponse;
  }

  async stop(identifier: string): Promise<DeleteProcessByIdentifierResponse> {
    const { response, data, error } = await deleteProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierResponse;
  }

  async kill(identifier: string): Promise<DeleteProcessByIdentifierKillResponse> {
    const { response, data, error } = await deleteProcessByIdentifierKill({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierKillResponse;
  }

  async logs(identifier: string, type: "stdout" | "stderr" = "stdout"): Promise<string> {
    const { response, data, error } = await getProcessByIdentifierLogs({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    if (data && type in data) {
      return data[type];
    }
    throw new Error("Unsupported log type");
  }
}

