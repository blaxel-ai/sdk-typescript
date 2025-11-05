import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { deleteFilesystemByPath, Directory, getFilesystemByPath, getWatchFilesystemByPath, putFilesystemByPath, PutFilesystemByPathError, SuccessResponse, postFilesystemMultipartInitiateByPath, putFilesystemMultipartByUploadIdPart, postFilesystemMultipartByUploadIdComplete, deleteFilesystemMultipartByUploadIdAbort, MultipartInitiateResponse, MultipartUploadPartResponse, MultipartPartInfo } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { CopyResponse, SandboxFilesystemFile, WatchEvent } from "./types.js";
import { readFile, writeFile } from "fs/promises";

// Multipart upload constants
const MULTIPART_THRESHOLD = 1 * 1024 * 1024; // 1MB
const CHUNK_SIZE = 512 * 1024; // 512KB per part
const MAX_PARALLEL_UPLOADS = 3; // Number of parallel part uploads

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

    // Calculate content size in bytes
    const contentSize = new Blob([content]).size;

    // Use multipart upload for large files
    if (contentSize > MULTIPART_THRESHOLD) {
      const blob = new Blob([content]);
      return await this.uploadWithMultipart(path, blob, "0644");
    }

    // Use regular upload for small files
    const { response, data, error } = await putFilesystemByPath({
      path: { path },
      body: { content },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async writeBinary(path: string, content: Buffer | Blob | File | Uint8Array | string): Promise<SuccessResponse> {
    path = this.formatPath(path);

    // Convert content to Blob regardless of input type
    let fileBlob: Blob;

    // Check if it's already a Blob or File (including duck-typing for cross-realm Blobs)
    if (content instanceof Blob || content instanceof File) {
      fileBlob = content;
    } else if (typeof content === 'object' && content !== null &&
               'size' in content && 'type' in content &&
               'arrayBuffer' in content &&
               // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
               typeof (content as any).arrayBuffer === 'function') {
      // Handle Blob-like objects (cross-realm Blobs)
      fileBlob = content as unknown as Blob;
    } else if (Buffer.isBuffer(content)) {
      // Convert Buffer to Blob
      fileBlob = new Blob([content]);
    } else if (content instanceof Uint8Array) {
      // Convert Uint8Array to Blob
      fileBlob = new Blob([content]);
    } else if (ArrayBuffer.isView(content)) {
      // Handle other TypedArray views
      fileBlob = new Blob([content]);
    } else if (typeof content === 'string') {
      const buffer = await readFile(content);
      fileBlob = new Blob([buffer]);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const typeName = (content as any)?.constructor?.name ?? typeof content;
      throw new Error(`Unsupported content type: ${typeName}`);
    }

    // Use multipart upload for large files
    if (fileBlob.size > MULTIPART_THRESHOLD) {
      return await this.uploadWithMultipart(path, fileBlob, "0644");
    }

    // Use regular upload for small files
    const formData = new FormData();
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

    return await response.json() as SuccessResponse;
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

  async readBinary(path: string): Promise<Blob> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath({
      path: { path },
      baseUrl: this.url,
      client: this.client,
      headers: {
        'Accept': 'application/octet-stream',
      },
    });
    this.handleResponseError(response, data, error);
    if (typeof data === 'string') {
      return new Blob([data]);
    }
    return data as Blob;
  }

  async download(src: string, destinationPath: string, { mode = 0o644 }: { mode?: number } = {}): Promise<void> {
    const blob = await this.readBinary(src);
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await writeFile(destinationPath, buffer, { mode: mode ?? 0o644 });
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

  async cp(source: string, destination: string, { maxWait = 180000 }: { maxWait?: number } = {}): Promise<CopyResponse> {
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
                await callback({ ...fileEvent, content: content });
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

  // Multipart upload helper methods
  private async initiateMultipartUpload(path: string, permissions: string = "0644"): Promise<MultipartInitiateResponse> {
    path = this.formatPath(path);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const { data } = await postFilesystemMultipartInitiateByPath({
      path: { path },
      body: { permissions },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    } as any);
    return data as MultipartInitiateResponse;
  }

  private async uploadPart(uploadId: string, partNumber: number, fileBlob: Blob): Promise<MultipartUploadPartResponse> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const { data } = await putFilesystemMultipartByUploadIdPart({
      path: { uploadId },
      query: { partNumber },
      body: { file: fileBlob },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    } as any);
    return data as MultipartUploadPartResponse;
  }

  private async completeMultipartUpload(uploadId: string, parts: Array<MultipartPartInfo>): Promise<SuccessResponse> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const { data } = await postFilesystemMultipartByUploadIdComplete({
      path: { uploadId },
      body: { parts },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    } as any);
    return data as SuccessResponse;
  }

  private async abortMultipartUpload(uploadId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await deleteFilesystemMultipartByUploadIdAbort({
      path: { uploadId },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    } as any);
  }

  private async uploadWithMultipart(path: string, blob: Blob, permissions: string = "0644"): Promise<SuccessResponse> {
    // Initiate multipart upload
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const initResponse = await this.initiateMultipartUpload(path, permissions);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const uploadId = initResponse.uploadId;

    if (!uploadId) {
      throw new Error("Failed to get upload ID from initiate response");
    }

    try {
      const size = blob.size;
      const numParts = Math.ceil(size / CHUNK_SIZE);
      const parts: Array<MultipartPartInfo> = [];

      // Upload parts in batches for parallel processing
      for (let i = 0; i < numParts; i += MAX_PARALLEL_UPLOADS) {
        const batch: Array<Promise<MultipartUploadPartResponse>> = [];

        for (let j = 0; j < MAX_PARALLEL_UPLOADS && i + j < numParts; j++) {
          const partNumber = i + j + 1;
          const start = (partNumber - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, size);
          const chunk = blob.slice(start, end);

          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          batch.push(this.uploadPart(uploadId, partNumber, chunk));
        }

        // Wait for batch to complete
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const batchResults = await Promise.all(batch);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
        parts.push(...batchResults.map((r: MultipartUploadPartResponse) => ({ partNumber: r.partNumber, etag: r.etag })));
      }

      // Sort parts by partNumber to ensure correct order
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      parts.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));

      // Complete the upload
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return await this.completeMultipartUpload(uploadId, parts);
    } catch (error) {
      // Abort the upload on failure
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await this.abortMultipartUpload(uploadId);
      } catch (abortError) {
        // Log but don't throw - we want to throw the original error
        console.error('Failed to abort multipart upload:', abortError);
      }
      throw error;
    }
  }
}
