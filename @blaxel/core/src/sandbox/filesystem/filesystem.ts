import axios from "axios";
import z from "zod";
import { Sandbox } from "../../client/types.gen.js";
import { FormData } from "../../common/node.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { deleteFilesystemByPath, Directory, getFilesystemByPath, getWatchFilesystemByPath, putFilesystemByPath, PutFilesystemByPathError, SuccessResponse } from "../client/index.js";
import { CopyResponse, CpParamsSchema, LsParamsSchema, MkdirParamsSchema, ReadParamsSchema, RmParamsSchema, SandboxFilesystemFile, ToolWithExecute, ToolWithoutExecute, WatchEvent, WriteParamsSchema } from "./types.js";



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

    let formData: any;
    if (typeof globalThis !== "undefined" && typeof globalThis.FormData !== "undefined" && !(typeof process !== "undefined" && process.versions && process.versions.node)) {
      // Browser environment
      formData = new globalThis.FormData();
      formData.append("permissions", "0644");
      formData.append("path", path);
      let fileContent: Blob | File;
      if (content instanceof Blob || content instanceof File) {
        fileContent = content;
      } else if (content instanceof Uint8Array) {
        fileContent = new Blob([content]);
      } else {
        fileContent = new Blob([content]);
      }
      formData.append("file", fileContent, "test-binary.bin");
    } else {
      // Node.js environment
      // @ts-expect-error: Only available in Node.js
      formData = new FormData();
      let fileContent: Buffer;
      if (Buffer.isBuffer(content)) {
        fileContent = content;
      } else if (content instanceof Uint8Array) {
        fileContent = Buffer.from(content);
      } else {
        throw new Error("Unsupported content type in Node.js");
      }
      formData.append("file", fileContent, "test-binary.bin");
    }

    // Get the correct headers from form-data
    const formHeaders = formData.getHeaders ? formData.getHeaders() : {};
    let url = `${this.url}/filesystem/${path}`;
    if (this.sandbox.forceUrl) {
      url = `${this.sandbox.forceUrl}/filesystem/${path}`;
    }
    let headers = { ...settings.headers, ...formHeaders };
    if (this.sandbox.headers) {
      headers = { ...headers, ...this.sandbox.headers };
    }

    const response = await axios.put(url, formData, {
      headers,
    });
    if (response.status !== 200) {
      throw new Error(response.data);
    }
    return response.data;
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
    const path = destinationPath ?? ""
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
    return data;
  }

  async cp(source: string, destination: string): Promise<CopyResponse> {
    source = this.formatPath(source);
    destination = this.formatPath(destination);
    const { response, data, error } = await getFilesystemByPath({
      path: { path: source },
      baseUrl: this.url,
      client: this.client,
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
    let controller: AbortController | null = new AbortController();

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
            const trimmed = line.trim();
            if (!trimmed) continue;
            const fileEvent = JSON.parse(line.trim()) as WatchEvent;
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
              } catch (e) {
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

  get toolsWithoutExecute(): ToolWithoutExecute {
    return {
      cp: {
        description: "Copy a file or directory",
        parameters: CpParamsSchema,
      },
      mkdir: {
        description: "Create a directory",
        parameters: MkdirParamsSchema,
      },
      ls: {
        description: "List a directory",
        parameters: LsParamsSchema,
      },
      rm: {
        description: "Remove a file or directory",
        parameters: RmParamsSchema,
      },
      read: {
        description: "Read a file",
        parameters: ReadParamsSchema,
      },
      write: {
        description: "Write a file",
        parameters: WriteParamsSchema,
      }
    }
  }

  get tools(): ToolWithExecute {
    return {
      cp: {
        description: "Copy a file or directory",
        parameters: CpParamsSchema,
        execute: async (args: z.infer<typeof CpParamsSchema>) => {
          try {
            const result = await this.cp(args.source, args.destination);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                source: args.source,
                destination: args.destination
              })
            }
            return "An unknown error occurred"
          }
        }
      },
      mkdir: {
        description: "Create a directory",
        parameters: MkdirParamsSchema,
        execute: async (args: z.infer<typeof MkdirParamsSchema>) => {
          try {
            const result = await this.mkdir(args.path, args.permissions);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                path: args.path,
                permissions: args.permissions
              })
            }
            return "An unknown error occurred"
          }
        }
      },
      ls: {
        description: "List a directory",
        parameters: LsParamsSchema,
        execute: async (args: z.infer<typeof LsParamsSchema>) => {
          try {
            const result = await this.ls(args.path);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                path: args.path
              })
            }
            return "An unknown error occurred"
          }
        }
      },
      rm: {
        description: "Remove a file or directory",
        parameters: RmParamsSchema,
        execute: async (args: z.infer<typeof RmParamsSchema>) => {
          try {
            const result = await this.rm(args.path, args.recursive);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                path: args.path,
                recursive: args.recursive
              })
            }
            return "An unknown error occurred"
          }
        }
      },
      read: {
        description: "Read a file",
        parameters: ReadParamsSchema,
        execute: async (args: z.infer<typeof ReadParamsSchema>) => {
          try {
            const result = await this.read(args.path);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                path: args.path
              })
            }
            return "An unknown error occurred"
          }
        }
      },
      write: {
        description: "Write a file",
        parameters: WriteParamsSchema,
        execute: async (args: z.infer<typeof WriteParamsSchema>) => {
          try {
            const result = await this.write(args.path, args.content);
            return JSON.stringify(result);
          } catch (e) {
            if (e instanceof Error) {
              return JSON.stringify({
                message: e.message,
                path: args.path,
                content: args.content
              })
            }
            return "An unknown error occurred"
          }
        }
      }
    }
  }
}