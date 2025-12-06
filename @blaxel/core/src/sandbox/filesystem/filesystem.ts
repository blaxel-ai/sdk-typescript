import { Sandbox } from "../../client/types.gen.js";
import { fs } from "../../common/node.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { ContentSearchResponse, deleteFilesystemByPath, deleteFilesystemMultipartByUploadIdAbort, Directory, FindResponse, FuzzySearchResponse, getFilesystemByPath, getFilesystemContentSearchByPath, getFilesystemFindByPath, getFilesystemSearchByPath, getWatchFilesystemByPath, MultipartInitiateResponse, MultipartPartInfo, MultipartUploadPartResponse, postFilesystemMultipartByUploadIdComplete, postFilesystemMultipartInitiateByPath, putFilesystemByPath, PutFilesystemByPathError, putFilesystemMultipartByUploadIdPart, SuccessResponse } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { CopyResponse, FilesystemFindOptions, FilesystemGrepOptions, FilesystemSearchOptions, SandboxFilesystemFile, WatchEvent } from "./types.js";

// Multipart upload constants
const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per part
const MAX_PARALLEL_UPLOADS = 20; // Number of parallel part uploads

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
      // Read file from local filesystem (Node.js only)
      if (!fs) {
        throw new Error("File path upload is only supported in Node.js environments");
      }
      const buffer = fs.readFileSync(content);
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
    if (!fs) {
      throw new Error("File download to local filesystem is only supported in Node.js environments");
    }
    const blob = await this.readBinary(src);
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(destinationPath, buffer, { mode: mode ?? 0o644 });
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

  async search(
    query: string,
    path: string = "/",
    options?: FilesystemSearchOptions
  ): Promise<FuzzySearchResponse> {
    const formattedPath = this.formatPath(path);

    const queryParams: {
      maxResults?: number;
      patterns?: string;
      excludeDirs?: string;
      excludeHidden?: boolean;
    } = {};

    if (options?.maxResults !== undefined) {
      queryParams.maxResults = options.maxResults;
    }
    if (options?.patterns && options.patterns.length > 0) {
      queryParams.patterns = options.patterns.join(',');
    }
    if (options?.excludeDirs && options.excludeDirs.length > 0) {
      queryParams.excludeDirs = options.excludeDirs.join(',');
    }
    if (options?.excludeHidden !== undefined) {
      queryParams.excludeHidden = options.excludeHidden;
    }

    const result = await getFilesystemSearchByPath({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
      client: this.client,
    });

    this.handleResponseError(result.response, result.data, result.error);
    return result.data as FuzzySearchResponse;
  }

  async find(
    path: string,
    options?: FilesystemFindOptions
  ): Promise<FindResponse> {
    const formattedPath = this.formatPath(path);

    const queryParams: {
      type?: string;
      patterns?: string;
      maxResults?: number;
      excludeDirs?: string;
      excludeHidden?: boolean;
    } = {};

    if (options?.type) {
      queryParams.type = options.type;
    }
    if (options?.patterns && options.patterns.length > 0) {
      queryParams.patterns = options.patterns.join(',');
    }
    if (options?.maxResults !== undefined) {
      queryParams.maxResults = options.maxResults;
    }
    if (options?.excludeDirs && options.excludeDirs.length > 0) {
      queryParams.excludeDirs = options.excludeDirs.join(',');
    }
    if (options?.excludeHidden !== undefined) {
      queryParams.excludeHidden = options.excludeHidden;
    }

    const result = await getFilesystemFindByPath({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(result.response, result.data, result.error);
    return result.data as FindResponse;
  }

  async grep(
    query: string,
    path: string = "/",
    options?: FilesystemGrepOptions
  ): Promise<ContentSearchResponse> {
    const formattedPath = this.formatPath(path);

    const queryParams: {
      query: string;
      caseSensitive?: boolean;
      contextLines?: number;
      maxResults?: number;
      filePattern?: string;
      excludeDirs?: string;
    } = {
      query,
    };

    if (options?.caseSensitive !== undefined) {
      queryParams.caseSensitive = options.caseSensitive;
    }
    if (options?.contextLines !== undefined) {
      queryParams.contextLines = options.contextLines;
    }
    if (options?.maxResults !== undefined) {
      queryParams.maxResults = options.maxResults;
    }
    if (options?.filePattern) {
      queryParams.filePattern = options.filePattern;
    }
    if (options?.excludeDirs && options.excludeDirs.length > 0) {
      queryParams.excludeDirs = options.excludeDirs.join(',');
    }

    const result = await getFilesystemContentSearchByPath({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
      client: this.client,
    });

    this.handleResponseError(result.response, result.data, result.error);
    return result.data as ContentSearchResponse;
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

    const { data } = await postFilesystemMultipartInitiateByPath({
      path: { path },
      body: { permissions },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    });
    return data;
  }

  private async uploadPart(uploadId: string, partNumber: number, fileBlob: Blob): Promise<MultipartUploadPartResponse> {

    const { data } = await putFilesystemMultipartByUploadIdPart({
      path: { uploadId },
      query: { partNumber },
      body: { file: fileBlob },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    });
    return data;
  }

  private async completeMultipartUpload(uploadId: string, parts: Array<MultipartPartInfo>): Promise<SuccessResponse> {
    const { data } = await postFilesystemMultipartByUploadIdComplete({
      path: { uploadId },
      body: { parts },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    });
    return data;
  }

  private async abortMultipartUpload(uploadId: string): Promise<SuccessResponse> {
    const { data } = await deleteFilesystemMultipartByUploadIdAbort({
      path: { uploadId },
      baseUrl: this.url,
      client: this.client,
      throwOnError: true,
    });
    return data;
  }

  private async uploadWithMultipart(path: string, blob: Blob, permissions: string = "0644"): Promise<SuccessResponse> {
    // Initiate multipart upload

    const initResponse = await this.initiateMultipartUpload(path, permissions);

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


          batch.push(this.uploadPart(uploadId, partNumber, chunk));
        }

        // Wait for batch to complete

        const batchResults = await Promise.all(batch);
        parts.push(...batchResults);
      }

      // Sort parts by partNumber to ensure correct order

      parts.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));

      // Complete the upload

      return await this.completeMultipartUpload(uploadId, parts);
    } catch (error) {
      // Abort the upload on failure
      try {

        await this.abortMultipartUpload(uploadId);
      } catch (abortError) {
        // Log but don't throw - we want to throw the original error
        console.error('Failed to abort multipart upload:', abortError);
      }
      throw error;
    }
  }
}
