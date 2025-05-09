import { Sandbox } from "../client/types.gen.js";
import { SandboxAction } from "./action.js";
import { deleteFilesystemByPath, Directory, getFilesystemByPath, putFilesystemByPath, SuccessResponse } from "./client/index.js";
import { getWatchFilesystemByPath } from "./client/sdk.gen.js";

export type CopyResponse = {
  message: string;
  source: string;
  destination: string;
}

export class SandboxFileSystem extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async mkdir(path: string, permissions: string = "0755"): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await putFilesystemByPath({
      path: { path },
      body: { isDirectory: true, permissions },
      baseUrl: this.url,
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
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async read(path: string): Promise<string> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    if (data && 'content' in data) {
      return data.content as string;
    }
    throw new Error("Unsupported file type");
  }

  async rm(path: string, recursive: boolean = false): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await deleteFilesystemByPath({
      path: { path },
      query: { recursive },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    if (!data || !('files' in data || 'subdirectories' in data)) {
      throw new Error(JSON.stringify({ error: "Directory not found" }));
    }
    return data;
  }

  async cp(source: string, destination: string): Promise<CopyResponse> {
    source = this.formatPath(source);
    destination = this.formatPath(destination);
    const { response, data, error } = await getFilesystemByPath({
      path: { path: source },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    if (data && ('files' in data || 'subdirectories' in data)) {
      // Create destination directory
      await this.mkdir(destination);

      // Process subdirectories in batches of 5
      const subdirectories = data.subdirectories || [];
      for (let i = 0; i < subdirectories.length; i += 5) {
        const batch = subdirectories.slice(i, i + 5);
        await Promise.all(
          batch.map(async (subdir) => {
            const sourcePath = subdir.path || `${source}/${subdir.path}`;
            const destPath = `${destination}/${subdir.path}`;
            await this.cp(sourcePath, destPath);
          })
        );
      }

      // Process files in batches of 10
      const files = data.files || [];
      for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);
        await Promise.all(
          batch.map(async (file) => {
            const sourcePath = file.path || `${source}/${file.path}`;
            const destPath = `${destination}/${file.path}`;
            const fileContent = await this.read(sourcePath);
            if (typeof fileContent === 'string') {
              await this.write(destPath, fileContent);
            }
          })
        );
      }
      return {
        message: "Directory copied successfully",
        source,
        destination,
      }
    } else if (data && 'content' in data) {
      await this.write(destination, data.content as string);
      return {
        message: "File copied successfully",
        source,
        destination,
      }
    }
    throw new Error("Unsupported file type");
  }

  /**
   * Watch for changes in a directory. Calls the callback with the changed file path (and optionally its content).
   * Returns a handle with a close() method to stop watching.
   * @param path Directory to watch
   * @param callback Function called on each change: (filePath, content?)
   * @param withContent If true, also fetches and passes the file content (default: false)
   */
  watch(
    path: string,
    callback: (filePath: string, content?: string) => void | Promise<void>,
    options?: {
      onError?: (error: Error) => void,
      withContent: boolean
    }
  ) {
    path = this.formatPath(path);
    let closed = false;
    let controller: AbortController | null = new AbortController();

    const start = async () => {
      const { response, data, error } = await getWatchFilesystemByPath({
        path: { path },
        baseUrl: this.url,
        parseAs: 'stream',
        signal: controller!.signal,
      });
      if (error) throw error;
      const stream: ReadableStream | null = (data as any) ?? response.body;
      if (!stream) throw new Error('No stream returned');
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            const filePath = line.trim();
            if (!filePath) continue;
            if (options?.withContent) {
              try {
                const content = await this.read(filePath);
                await callback(filePath, content);
              } catch (e) {
                await callback(filePath, undefined);
              }
            } else {
              await callback(filePath);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    };
    start().catch((err) => {
      // Suppress AbortError when closing
      if (!(err && err.name === 'AbortError')) {
        if (options?.onError) {
          options.onError(err);
        }
      }
      closed = true;
      controller?.abort();
    });
    return {
      close: () => {
        closed = true;
        controller?.abort();
      },
    };
  }

  private formatPath(path: string): string {
    if (path === "/") {
      return path;
    }
    if (path.startsWith("/")) {
      path = path.slice(1);
    }
    return path;
  }
}