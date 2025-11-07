import { SandboxAction } from "../action.js";
import { WebSocketClient } from "../websocket/index.js";
import { Directory, SuccessResponse } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { SandboxProcessWebSocket } from "../process/process-ws.js";
import { SandboxFileSystem } from "./filesystem.js";
import { CopyResponse, SandboxFilesystemFile, WatchEvent } from "./types.js";
import { SandboxConfiguration } from "../types.js";

export class SandboxFileSystemWebSocket extends SandboxAction {
  private wsClient: WebSocketClient;
  private httpClient: SandboxFileSystem;

  constructor(sandbox: SandboxConfiguration, private process: SandboxProcess | SandboxProcessWebSocket, wsClient: WebSocketClient) {
    super(sandbox);
    this.wsClient = wsClient;
    // Create HTTP client for fallback operations
    this.httpClient = new SandboxFileSystem(sandbox, process);
  }

  async mkdir(path: string, permissions: string = "0755"): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const data = await this.wsClient.send<SuccessResponse>("filesystem:create", {
      path,
      isDirectory: true,
      permissions,
    });
    return data;
  }

  async write(path: string, content: string): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const data = await this.wsClient.send<SuccessResponse>("filesystem:create", {
      path,
      content,
      isDirectory: false,
    });
    return data;
  }

  async writeBinary(path: string, content: Buffer | Blob | File | Uint8Array | string): Promise<SuccessResponse> {
    return this.httpClient.writeBinary(path, content);
  }

  async writeTree(files: SandboxFilesystemFile[], destinationPath: string | null = null) {
    const path = this.formatPath(destinationPath ?? "");
    const filesMap = files.reduce((acc, file) => {
      acc[file.path] = file.content;
      return acc;
    }, {} as Record<string, string>);

    const data = await this.wsClient.send<Directory>("filesystem:tree:create", {
      path,
      files: filesMap,
    });
    return data;
  }

  async read(path: string): Promise<string> {
    path = this.formatPath(path);
    const data = await this.wsClient.send<{ content: string }>("filesystem:get", { path });
    return data.content;
  }

  async readBinary(path: string): Promise<Blob> {
    // Binary downloads are better suited for HTTP
    // Fall back to HTTP client for binary operations
    return this.httpClient.readBinary(path);
  }

  async download(src: string, destinationPath: string, options: { mode?: number } = {}): Promise<void> {
    // File downloads are better suited for HTTP
    // Fall back to HTTP client
    return this.httpClient.download(src, destinationPath, options);
  }

  async rm(path: string, recursive: boolean = false): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const data = await this.wsClient.send<SuccessResponse>("filesystem:delete", {
      path,
      recursive,
    });
    return data;
  }

  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    const data = await this.wsClient.send<Directory>("filesystem:get", { path });
    return data;
  }

  async cp(source: string, destination: string, { maxWait = 180000 }: { maxWait?: number } = {}): Promise<CopyResponse> {
    // Copy operation is typically done via process execution
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let process = await this.process.exec({
      command: `cp -r ${source} ${destination}`,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
    process = await this.process.wait(process.pid, { maxWait, interval: 100 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (process.status === "failed") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      throw new Error(`Could not copy ${source} to ${destination} cause: ${process.logs as string}`);
    }
    return {
      message: "Files copied",
      source,
      destination,
    };
  }

  watch(
    path: string,
    callback: (fileEvent: WatchEvent) => void | Promise<void>,
    options?: {
      onError?: (error: Error) => void;
      withContent: boolean;
      ignore?: string[];
    }
  ): { close: () => void } {
    // File watching uses HTTP streaming which is already optimized
    // Fall back to HTTP client
    return this.httpClient.watch(path, callback, options);
  }

  private formatPath(path: string): string {
    return path;
  }
}

