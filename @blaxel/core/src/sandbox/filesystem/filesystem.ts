import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { deleteFilesystemByPath, Directory, getFilesystemByPath, getWatchFilesystemByPath, putFilesystemByPath, PutFilesystemByPathError, SuccessResponse } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { CopyResponse, SandboxFilesystemFile, WatchEvent } from "./types.js";



export class SandboxFileSystem extends SandboxAction {
  constructor(sandbox: Sandbox, private process: SandboxProcess) {
    super(sandbox);
    this.process = process;
  }

  async mkdir(path: string, permissions: string = "0755"): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await putFilesystemByPath({
      path: { path },
      body: { isDirectory: true, permissions },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async write(path: string, content: string): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await putFilesystemByPath({
      path: { path },
      body: { content },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async writeBinary(path: string, content: Buffer | Blob | File | Uint8Array) {
    path = this.formatPath(path);
    const formData = new FormData();

    // Convert content to Blob regardless of input type
    let fileBlob: Blob;
    if (content instanceof Blob || content instanceof File) {
      fileBlob = content;
    } else if (Buffer.isBuffer(content)) {
      // Convert Buffer to Blob
      fileBlob = new Blob([content]);
    } else if (content instanceof Uint8Array) {
      // Convert Uint8Array to Blob
      fileBlob = new Blob([content]);
    } else {
      throw new Error("Unsupported content type");
    }

    // Append the file as a Blob
    formData.append("file", fileBlob, "test-binary.bin");
    formData.append("permissions", "0644");
    formData.append("path", path);

    // Build URL
    let url = `${this.url}/filesystem/${path}`;
    if (this.forcedUrl) {
      url = `${this.forcedUrl.toString()}/filesystem/${path}`;
    }

    // Make the request using fetch instead of axios for better FormData handling
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...settings.headers,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to write binary: ${response.status} ${errorText}`);
    }

    return await response.json();
  }

  async writeTree(files: SandboxFilesystemFile[], destinationPath: string | null = null) {
    const options = {
      body: {
        files: files.reduce((acc, file) => {
          acc[file.path] = file.content;
          return acc;
        }, {} as Record<string, string>),
      },
      baseUrl: this.url,
      client: this.client,
    }
    const path = this.formatPath(destinationPath ?? "")
    const { response, data, error } = await this.client.put<Directory, PutFilesystemByPathError>({
      url: `/filesystem/tree/${path}`,
      ...options,
      headers: {
        'Content-Type': 'application/json',
      }
    })
    this.handleResponseError(response, data, error);
    return data;
  }

  async read(path: string): Promise<string> {
    path = this.formatPath(path);

    const { response, data, error } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    if (data && 'content' in data) {
      return data.content;
    }
    throw new Error("Unsupported file type");
  }

  async rm(path: string, recursive: boolean = false): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await deleteFilesystemByPath({
      path: { path },
      query: { recursive },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    if (!data || !('files' in data || 'subdirectories' in data)) {
      throw new Error(JSON.stringify({ error: "Directory not found" }));
    }
    return data as Directory;
  }

  async cp(source: string, destination: string, { maxWait = 1000 * 60 * 60 }: { maxWait?: number } = {}): Promise<CopyResponse> {
    let process = await this.process.exec({
      command: `cp -r ${source} ${destination}`,
    })
    process = await this.process.wait(process.pid, { maxWait, interval: 100 })
    if (process.status === "failed") {
      throw new Error(`Could not copy ${source} to ${destination} cause: ${process.logs}`)
    }
    return {
      message: "Files copied",
      source,
      destination,
    }
  }

  watch(
    path: string,
    callback: (fileEvent: WatchEvent) => void | Promise<void>,
    options?: {
      onError?: (error: Error) => void,
      withContent: boolean,
      ignore?: string[]
    }
  ) {
    path = this.formatPath(path);
    let closed = false;
    const controller = new AbortController();

    const start = async () => {
      const query: { ignore?: string } = {}
      if (options?.ignore) {
        query.ignore = options.ignore.join(",");
      }
      const { response, data, error } = await getWatchFilesystemByPath({
        client: this.client,
        path: { path },
        query,
        baseUrl: this.url,
        parseAs: 'stream',
        signal: controller.signal,
      });
      if (error) throw new Error(error instanceof Error ? error.message : JSON.stringify(error));
      const stream: ReadableStream | null = (data as unknown as ReadableStream) ?? response.body;
      if (!stream) throw new Error('No stream returned');
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Skip keepalive messages
            if (line.startsWith("[keepalive]")) {
              continue;
            }
            const fileEvent = JSON.parse(trimmed) as WatchEvent;
            if (options?.withContent && ["CREATE", "WRITE"].includes(fileEvent.op)) {
              try {
                let filePath = ""
                if (fileEvent.path.endsWith("/")) {
                  filePath = fileEvent.path + fileEvent.name;
                } else {
                  filePath = fileEvent.path + "/" + fileEvent.name;
                }

                const content = await this.read(filePath);
                await callback({ ...fileEvent, content });
              } catch {
                await callback({ ...fileEvent, content: undefined });
              }
            } else {
              await callback(fileEvent);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    };
    start().catch((err: unknown) => {
      // Suppress AbortError when closing
      if (!(err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError')) {
        if (options?.onError) {
          options.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      closed = true;
      controller.abort();
    });
    return {
      close: () => {
        closed = true;
        controller.abort();
      },
    };
  }

  private formatPath(path: string): string {
    return path;
  }
}
