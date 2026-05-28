import { Sandbox } from "../../client/types.gen.js";
import { fs } from "../../common/node.js";
import { settings } from "../../common/settings.js";
import { withUploadSlot } from "../../common/h2fetch.js";
import { SandboxAction } from "../action.js";
import { ContentSearchResponse, deleteFilesystemByPath, deleteFilesystemMultipartByUploadIdAbort, Directory, FindResponse, FuzzySearchResponse, getFilesystemByPath, getFilesystemContentSearchByPath, getFilesystemFindByPath, getFilesystemSearchByPath, getWatchFilesystemByPath, MultipartInitiateResponse, MultipartPartInfo, MultipartUploadPartResponse, postFilesystemMultipartByUploadIdComplete, postFilesystemMultipartInitiateByPath, putFilesystemByPath, PutFilesystemByPathError, putFilesystemMultipartByUploadIdPart, SuccessResponse } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { CopyResponse, FilesystemFindOptions, FilesystemGrepOptions, FilesystemSearchOptions, SandboxFilesystemFile, WatchEvent } from "./types.js";

// Multipart upload constants
const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per part
const MAX_PARALLEL_UPLOADS = 3; // Number of parallel part uploads

// Base backoff between part-upload retries, in milliseconds. Grows linearly
// per attempt and is jittered to avoid synchronized retries (thundering herd)
// when several parallel parts fail against the same edge at the same time.
const RETRY_BASE_DELAY_MS = 200;

// Markers that, when present anywhere in the error chain, are unambiguous
// signals of a transient HTTP/2 stream reset or connection drop. These are
// protocol/transport level codes, not application payloads, so substring
// matching them does not over-match a server-sent error body. Each entry is
// matched case-sensitively against the error message and its cause.
//
// Deliberately excluded: bare "INTERNAL_ERROR" and "fetch failed". Both are
// too generic on their own (an application 500 body or any failed fetch would
// match), so we only treat them as transient when paired with a transport
// error code on the cause (see isTransientUploadError).
const TRANSIENT_RESET_MARKERS = [
  "ENHANCE_YOUR_CALM", // H2 flow-control backpressure reset
  "NGHTTP2_INTERNAL_ERROR", // H2 internal stream error (qualified form)
  "ERR_HTTP2", // node http2 error code family
  "GOAWAY", // peer is draining the connection
  "HTTP/2 session closed before response", // thrown by our own h2 transport
  "HTTP/2 session sent GOAWAY before response",
];

// Node-level error codes (from `error.code` / `error.cause.code`) that mean
// the connection itself dropped mid-flight and the request never completed.
// These are safe to retry for an idempotent part upload.
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
]);

function collectErrorText(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  // Walk the error -> cause chain (bounded) so a transport error wrapped by a
  // higher-level "fetch failed" is still classified correctly.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const node = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof node.message === "string") messages.push(node.message);
    if (typeof node.code === "string") codes.push(node.code);
    current = node.cause;
  }
  return { messages, codes };
}

// Exported for the real-transport fault-injection tests (not re-exported through
// the package barrel, so this is not part of the public API): they assert that
// errors produced by an ACTUAL node:http2 RST_STREAM/GOAWAY/socket-drop are
// classified transient, bridging the synthetic-error unit tests to reality.
export function isTransientUploadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { messages, codes } = collectErrorText(error);

  // 1. An explicit transient transport error code anywhere in the chain.
  if (codes.some((code) => TRANSIENT_ERROR_CODES.has(code))) {
    return true;
  }

  // 2. An unambiguous protocol-level reset marker in any message.
  if (messages.some((text) =>
    TRANSIENT_RESET_MARKERS.some((marker) => text.includes(marker)),
  )) {
    return true;
  }

  return false;
}

function nextRetryDelayMs(attempt: number): number {
  // Linear backoff (200ms, 400ms, ...) plus up to one extra base delay of
  // random jitter so concurrent part retries do not all fire on the same tick.
  const base = RETRY_BASE_DELAY_MS * attempt;
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return base + jitter;
}

// Exported for the real-transport fault-injection tests (not part of the public
// API; see isTransientUploadError above). This is the exact wrapper the upload
// paths use, so driving it over a real faulting H2 server proves the retry loop
// actually fires for production fault shapes, not just synthetic ones.
export async function retryOnTransient<T>(fn: () => Promise<T>): Promise<T> {
  const retries = settings.fsPartRetries; // default 3 (ENG-2680); 0 disables
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (retries <= 0 || attempt > retries || !isTransientUploadError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, nextRetryDelayMs(attempt)),
      );
    }
  }
}

export class SandboxFileSystem extends SandboxAction {
  constructor(sandbox: Sandbox, private process: SandboxProcess) {
    super(sandbox);
    this.process = process;
  }

  async mkdir(path: string, permissions: string = "0755"): Promise<SuccessResponse> {
    path = this.formatPath(path);
    const { response, data, error } = await putFilesystemByPath(this.withClient({
      path: { path },
      body: { isDirectory: true, permissions },
      baseUrl: this.url,
    }));
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
    const { response, data, error } = await putFilesystemByPath(this.withClient({
      path: { path },
      body: { content },
      baseUrl: this.url,
    }));
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

    // Use regular upload for small files. Run the PUT under the same upload
    // reliability wrapper as multipart parts: bound concurrency (ENG-2680) and
    // retry transient connection resets (ECONNRESET/GOAWAY/ENHANCE_YOUR_CALM). A
    // PUT of the same bytes to the same path is idempotent, so retry is safe.
    // The FormData is rebuilt per attempt so a retried request has a fresh body.
    let url = `${this.url}/filesystem/${path}`;
    if (this.forcedUrl) {
      url = `${this.forcedUrl.toString()}/filesystem/${path}`;
    }

    const h2Domain = this.sandbox?.h2Domain;
    const putOnce = async (): Promise<SuccessResponse> => {
      const formData = new FormData();
      formData.append("file", fileBlob, "test-binary.bin");
      formData.append("permissions", "0644");
      formData.append("path", path);

      const response = await this.h2Fetch(url, {
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
    };

    const doPut = () => retryOnTransient(putOnce);
    return h2Domain ? withUploadSlot(h2Domain, doPut) : doPut();
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
    const { response, data, error } = await getFilesystemByPath(this.withClient({
      path: { path },
      baseUrl: this.url,
    }));
    this.handleResponseError(response, data, error);
    if (data && 'content' in data) {
      return data.content;
    }
    throw new Error("Unsupported file type");
  }

  async readBinary(path: string): Promise<Blob> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath(this.withClient({
      path: { path },
      baseUrl: this.url,
      headers: {
        'Accept': 'application/octet-stream',
      },
    }));
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
    const { response, data, error } = await deleteFilesystemByPath(this.withClient({
      path: { path },
      query: { recursive },
      baseUrl: this.url,
    }));
    this.handleResponseError(response, data, error);
    return data as SuccessResponse;
  }

  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    const { response, data, error } = await getFilesystemByPath(this.withClient({
      path: { path },
      baseUrl: this.url,
    }));
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

    const result = await getFilesystemSearchByPath(this.withClient({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
    }));

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

    const result = await getFilesystemFindByPath(this.withClient({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
    }));
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

    const result = await getFilesystemContentSearchByPath(this.withClient({
      path: { path: formattedPath },
      query: queryParams,
      baseUrl: this.url,
    }));

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
      const { response, data, error } = await getWatchFilesystemByPath(this.withClient({
        path: { path },
        query,
        baseUrl: this.url,
        parseAs: 'stream',
        signal: controller.signal,
      }));
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

    const { data } = await postFilesystemMultipartInitiateByPath(this.withClient({
      path: { path },
      body: { permissions },
      baseUrl: this.url,
      throwOnError: true,
    }));
    return data;
  }

  private async uploadPart(uploadId: string, partNumber: number, fileBlob: Blob): Promise<MultipartUploadPartResponse> {

    const { data } = await putFilesystemMultipartByUploadIdPart(this.withClient({
      path: { uploadId },
      query: { partNumber },
      body: { file: fileBlob },
      baseUrl: this.url,
      throwOnError: true,
    }));
    return data;
  }

  private async completeMultipartUpload(uploadId: string, parts: Array<MultipartPartInfo>): Promise<SuccessResponse> {
    const { data } = await postFilesystemMultipartByUploadIdComplete(this.withClient({
      path: { uploadId },
      body: { parts },
      baseUrl: this.url,
      throwOnError: true,
    }));
    return data;
  }

  private async abortMultipartUpload(uploadId: string): Promise<SuccessResponse> {
    const { data } = await deleteFilesystemMultipartByUploadIdAbort(this.withClient({
      path: { uploadId },
      baseUrl: this.url,
      throwOnError: true,
    }));
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

      // Bound concurrent upload-part streams on the shared H2 connection so many
      // parts (within and across files) cannot burst past the server's
      // rapid-reset limit (ENG-2680). Scoped to uploads; default cap is 2. With
      // no h2Domain the parts go over globalThis.fetch on separate connections,
      // so the shared-connection cap does not apply.
      const h2Domain = this.sandbox?.h2Domain;

      // Upload parts in batches for parallel processing
      for (let i = 0; i < numParts; i += MAX_PARALLEL_UPLOADS) {
        const batch: Array<Promise<MultipartUploadPartResponse>> = [];

        for (let j = 0; j < MAX_PARALLEL_UPLOADS && i + j < numParts; j++) {
          const partNumber = i + j + 1;
          const start = (partNumber - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, size);
          const chunk = blob.slice(start, end);

          const uploadOne = () => retryOnTransient(() => this.uploadPart(uploadId, partNumber, chunk));
          batch.push(h2Domain ? withUploadSlot(h2Domain, uploadOne) : uploadOne());
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
