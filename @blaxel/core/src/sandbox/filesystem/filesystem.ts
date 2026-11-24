import { Sandbox } from "../../client/types.gen.js";
import { fs } from "../../common/node.js";
import { settings } from "../../common/settings.js";
import { withUploadSlot } from "../../common/h2fetch.js";
import { isTransientResetError, retryOnTransientReset } from "../../common/transient-retry.js";
import { shellQuote } from "../../common/shell.js";
import { SandboxAction } from "../action.js";
import type { GetFilesystemSearchByPathData } from "../client/index.js";
import { ContentSearchResponse, deleteFilesystemByPath, deleteFilesystemMultipartByUploadIdAbort, Directory, FindResponse, FuzzySearchResponse, getFilesystemByPath, getFilesystemContentSearchByPath, getFilesystemFindByPath, getFilesystemSearchByPath, getFilesystemTreeByPath, getWatchFilesystemByPath, MultipartInitiateResponse, MultipartPartInfo, MultipartUploadPartResponse, postFilesystemMultipartByUploadIdComplete, postFilesystemMultipartInitiateByPath, putFilesystemByPath, PutFilesystemByPathError, putFilesystemMultipartByUploadIdPart, SuccessResponse } from "../client/index.js";
import { SandboxProcess } from "../process/index.js";
import { SandboxFileExistsError } from "./copy-no-overwrite.js";
import { CopyResponse, FilesystemFindOptions, FilesystemGrepOptions, FilesystemSearchOptions, SandboxFilesystemFile, WatchEvent } from "./types.js";
import type { FilesystemReadTreeOptions } from "./types.js";

// Multipart upload constants
const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per part
const MAX_PARALLEL_UPLOADS = 3; // Maximum workers when the H2 upload cap is disabled

// The transient-reset classifier and retry loop live in
// common/transient-retry.ts, shared with the idempotent sandbox-op retry
// (read/list/etc.) so every path judges "transient" identically. These aliases
// preserve the import surface the ENG-2680 fault tests already depend on.
export const isTransientUploadError = isTransientResetError;
export function retryOnTransient<T>(fn: () => Promise<T>): Promise<T> {
  // Upload path keeps its own (lower) fsPartRetries budget; the shared helper
  // otherwise defaults to the higher idempotent-read budget (sandboxReadRetries).
  return retryOnTransientReset(fn, { retries: settings.fsPartRetries });
}

async function blobFromReadableStream(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

async function normalizeBinaryDownload(data: unknown, response: Response): Promise<Blob> {
  if (data instanceof Blob) return data;
  if (typeof data === "string") return new Blob([data]);
  if (data instanceof ArrayBuffer) return new Blob([data]);
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Blob([bytes]);
  }
  if (data instanceof ReadableStream) return blobFromReadableStream(data);
  if (response.body) return blobFromReadableStream(response.body);
  throw new Error(`Unsupported binary download response: ${data === null ? "null" : typeof data}`);
}

/**
 * The filesystem of a sandbox, available as `sandbox.fs`.
 *
 * Use absolute paths: a relative path is resolved from the working directory
 * of the sandbox API. Writes create missing parent directories and overwrite
 * existing files, so retrying a write is safe. `write()` and `writeBinary()`
 * upload content over 5 MB (5 * 1024 * 1024 bytes) in 5 MB parts, up to 3 at
 * a time, through the multipart upload API, with no change to the call.
 *
 * @example
 * ```typescript
 * await sandbox.fs.write("/app/main.py", "print('hi')");
 * const code = await sandbox.fs.read("/app/main.py");
 * const listing = await sandbox.fs.ls("/app");
 * const hits = await sandbox.fs.grep("TODO", "/app", { filePattern: "*.py" });
 * ```
 */
export class SandboxFileSystem extends SandboxAction {
  constructor(sandbox: Sandbox, private process: SandboxProcess) {
    super(sandbox);
    this.process = process;
  }

  /**
   * Create a directory, with any missing parents. An existing directory is kept.
   *
   * @param path - Absolute path of the directory.
   * @param permissions - Octal mode as a string. Defaults to `"0755"`.
   * @returns A confirmation message.
   */
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

  /**
   * Write a text file, replacing any existing content. Missing parent
   * directories are created. Content over 5 MB is uploaded in parts
   * automatically. For bytes, or a local file, use `writeBinary()`.
   *
   * @param path - Absolute path of the file.
   * @param content - Text to write (UTF-8).
   * @returns A confirmation message with the path.
   *
   * @example
   * ```typescript
   * await sandbox.fs.write("/app/config.json", JSON.stringify({ port: 3000 }));
   * ```
   */
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

  /**
   * Write a binary file, replacing any existing content. Missing parent
   * directories are created. Content over 5 MB is uploaded in 5 MB parts
   * automatically, and uploads are retried on transient connection resets.
   *
   * @param path - Absolute path of the file in the sandbox.
   * @param content - The bytes as a Buffer, Blob, File or Uint8Array, or a string holding the path of a local file to upload (Node.js only; the file is read into memory).
   * @returns A confirmation message with the path.
   *
   * @example
   * ```typescript
   * await sandbox.fs.writeBinary("/app/data.zip", "./data.zip");
   * await sandbox.fs.writeBinary("/app/logo.png", new Uint8Array(pngBytes));
   * ```
   */
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
      const stat = fs.statSync(content);
      // For files larger than MULTIPART_THRESHOLD, stream chunks directly
      // to avoid hitting Node.js Buffer size limit (2 GiB)
      if (stat.size > MULTIPART_THRESHOLD) {
        return await this.uploadFileWithMultipart(path, content, stat.size, "0644");
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

      // A forceUrl (session-token) sandbox carries its own headers and must not
      // require global credentials; settings.headers now throws without them
      // (ENG-2698). Mirror streamLogs/execWithStreaming, which already pick
      // sandbox.headers for forceUrl sessions.
      const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
      const response = await this.h2Fetch(url, {
        method: 'PUT',
        headers: {
          ...headers,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to write binary: ${response.status} ${errorText}`);
      }

      return await response.json() as SuccessResponse;
    };

    // Acquire the upload slot per-attempt INSIDE the retry so the per-domain cap
    // bounds in-flight streams, not retry sequences: the slot is released during
    // backoff, so a failing PUT never pins a slot while it sleeps (Mendral review).
    const putWithSlot = h2Domain ? () => withUploadSlot(h2Domain, putOnce) : putOnce;
    return retryOnTransient(putWithSlot);
  }

  /**
   * Write several text files in one request. Each file path is joined to
   * `destinationPath`; missing directories are created and existing files
   * are overwritten.
   *
   * @param files - Files as `{ path, content }`, with paths relative to `destinationPath`.
   * @param destinationPath - Directory to write into. Defaults to the working directory of the sandbox API.
   * @returns The resulting directory listing.
   *
   * @example
   * ```typescript
   * await sandbox.fs.writeTree([
   *   { path: "package.json", content: '{"name":"app"}' },
   *   { path: "src/index.js", content: "console.log('hi')" },
   * ], "/app");
   * ```
   */
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

  /**
   * Read a text file. Retried on transient connection resets. For binary
   * content use `readBinary()`.
   *
   * @param path - Absolute path of the file.
   * @returns The file content as a string.
   * @throws When the path does not exist or is a directory.
   *
   * @example
   * ```typescript
   * const text = await sandbox.fs.read("/app/package.json");
   * ```
   */
  async read(path: string): Promise<string> {
    path = this.formatPath(path);
    // Idempotent GET: self-heal a transient connection reset (e.g. first call
    // after sandbox resume). Non-transient errors (404, etc.) are not retried.
    return retryOnTransientReset(async () => {
      const { response, data, error } = await getFilesystemByPath(this.withClient({
        path: { path },
        baseUrl: this.url,
      }));
      this.handleResponseError(response, data, error);
      if (data && 'content' in data && typeof data.content === "string") {
        return data.content;
      }
      throw new Error("Unsupported file type");
    });
  }

  /**
   * Reads the whole tree under `path` in one request and returns the API's `Directory`: every
   * file below `path` in `files`, each regular file (or symlink to one) with its `content` as
   * UTF-8 text. The sandbox API applies `patterns`, `excludeDirs` and `excludeHidden`, and rejects,
   * returning nothing partial, when more than `maxFiles` files match or they hold more than
   * `maxBytes` bytes.
   */
  async readTree(path: string, options: FilesystemReadTreeOptions = {}): Promise<Directory> {
    const { patterns, excludeDirs, excludeHidden, maxFiles, maxBytes } = options;
    // Idempotent GET: self-heal a transient connection reset.
    return retryOnTransientReset(async () => {
      const { response, data, error } = await getFilesystemTreeByPath(this.withClient({
        path: { path: this.formatPath(path) },
        query: {
          recursive: true,
          content: true,
          patterns: patterns?.join(","),
          excludeDirs: excludeDirs?.join(","),
          excludeHidden,
          maxFiles,
          maxBytes,
        },
        baseUrl: this.url,
      }));
      this.handleResponseError(response, data, error);
      // An older sandbox API ignores the query and lists only direct children,
      // without `recursive`. Fail instead of returning that as the whole tree.
      if (data?.recursive !== true) {
        throw new Error("readTree needs a newer sandbox API: this sandbox does not support recursive tree reads; update its image");
      }
      return data;
    });
  }

  /**
   * Read a file as bytes. Retried on transient connection resets.
   *
   * @param path - Absolute path of the file.
   * @returns The file content as a Blob (use `await blob.arrayBuffer()` for the bytes).
   */
  async readBinary(path: string): Promise<Blob> {
    path = this.formatPath(path);
    // Idempotent GET: self-heal a transient connection reset.
    return retryOnTransientReset(async () => {
      const { response, data, error } = await getFilesystemByPath(this.withClient({
        path: { path },
        baseUrl: this.url,
        headers: {
          'Accept': 'application/octet-stream',
        },
        parseAs: 'blob',
      }));
      this.handleResponseError(response, data, error);
      return normalizeBinaryDownload(data, response);
    });
  }

  /**
   * Copy a file from the sandbox to the local filesystem (Node.js only). The
   * whole file is held in memory on the way.
   *
   * @param src - Absolute path of the file in the sandbox.
   * @param destinationPath - Local path to write to; an existing file is overwritten.
   * @param options - `mode`: permissions of the local file. Defaults to `0o644`.
   */
  async download(src: string, destinationPath: string, { mode = 0o644 }: { mode?: number } = {}): Promise<void> {
    if (!fs) {
      throw new Error("File download to local filesystem is only supported in Node.js environments");
    }
    const blob = await this.readBinary(src);
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(destinationPath, buffer, { mode: mode ?? 0o644 });
  }

  /**
   * Delete a file or directory.
   *
   * @param path - Absolute path to delete.
   * @param recursive - Set to true to delete a directory with its content. Defaults to false.
   * @returns A confirmation message.
   * @throws When the path does not exist (HTTP 404).
   */
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

  /**
   * List the direct content of a directory. Retried on transient connection
   * resets. For a search through subdirectories use `find()`.
   *
   * @param path - Absolute path of the directory.
   * @returns The directory with its `files` (name, path, size in bytes, permissions, owner, lastModified) and `subdirectories`.
   * @throws When the path does not exist or is not a directory.
   */
  async ls(path: string): Promise<Directory> {
    path = this.formatPath(path);
    // Idempotent GET: self-heal a transient connection reset (the file-tree
    // refresh that customers hit as intermittent 500s after sandbox resume).
    return retryOnTransientReset(async () => {
      const { response, data, error } = await getFilesystemByPath(this.withClient({
        path: { path },
        baseUrl: this.url,
      }));
      this.handleResponseError(response, data, error);
      if (!data || !('files' in data || 'subdirectories' in data)) {
        throw new Error(JSON.stringify({ error: "Directory not found" }));
      }
      return data as Directory;
    });
  }

  /**
   * Fuzzy search for file and directory paths, like an editor's "go to file".
   *
   * @param query - Fuzzy pattern matched against each path relative to `path`, for example `"mngo"` for `src/main.go`.
   * @param path - Directory to search in. Defaults to `/`.
   * @param options - `maxResults` (default 20); `excludeDirs`, directory names to skip (default `node_modules`, `vendor`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.venv`, `.next`, `coverage`); `excludeHidden` (default true). `patterns` is currently ignored by the API; use `find()` for glob filtering.
   * @returns Matches with `path`, `score` and `type` (`"file"` or `"directory"`), best first, and the `total` count.
   */
  async search(
    query: string,
    path: string = "/",
    options?: FilesystemSearchOptions
  ): Promise<FuzzySearchResponse> {
    const formattedPath = this.formatPath(path);

    const queryParams: NonNullable<GetFilesystemSearchByPathData["query"]> = { query };

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

    return retryOnTransientReset(async () => {
      const result = await getFilesystemSearchByPath(this.withClient({
        path: { path: formattedPath },
        query: queryParams,
        baseUrl: this.url,
      }));
      this.handleResponseError(result.response, result.data, result.error);
      return result.data as FuzzySearchResponse;
    });
  }

  /**
   * Find files or directories under a path by glob pattern, searching
   * subdirectories.
   *
   * @param path - Directory to search in.
   * @param options - `type`: `"file"` or `"directory"`; `patterns`: globs matched against file names (not directories), such as `["*.ts", "*.json"]`; `maxResults` (default 20, `0` returns all); `excludeDirs`, directory names to skip (default `node_modules`, `vendor`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.venv`, `.next`, `coverage`); `excludeHidden` (default true).
   * @returns Matches with `path` and `type`, and the `total` count.
   *
   * @example
   * ```typescript
   * const { matches } = await sandbox.fs.find("/app", { type: "file", patterns: ["*.ts"], maxResults: 0 });
   * ```
   */
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

    return retryOnTransientReset(async () => {
      const result = await getFilesystemFindByPath(this.withClient({
        path: { path: formattedPath },
        query: queryParams,
        baseUrl: this.url,
      }));
      this.handleResponseError(result.response, result.data, result.error);
      return result.data as FindResponse;
    });
  }

  /**
   * Search file contents for a plain-text string (not a regular expression),
   * line by line, under a directory and its subdirectories.
   *
   * @param query - Text to look for.
   * @param path - Directory to search in. Defaults to `/`.
   * @param options - `caseSensitive` (default false); `contextLines`, lines returned before and after each match in `context` (default 0, max 20); `maxResults` (default 100); `filePattern`, a glob matched against the file name such as `"*.go"`; `excludeDirs`, directory names to skip (default `node_modules`, `vendor`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.venv`, `.next`, `coverage`).
   * @returns Matches with `path`, `line`, `column`, `text` and optional `context`, and the `total` count.
   *
   * @example
   * ```typescript
   * const { matches } = await sandbox.fs.grep("TODO", "/app/src", { filePattern: "*.ts", contextLines: 2 });
   * ```
   */
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

    return retryOnTransientReset(async () => {
      const result = await getFilesystemContentSearchByPath(this.withClient({
        path: { path: formattedPath },
        query: queryParams,
        baseUrl: this.url,
      }));
      this.handleResponseError(result.response, result.data, result.error);
      return result.data as ContentSearchResponse;
    });
  }

  /**
   * Copy a file or directory inside the sandbox. By default it runs `cp -r`
   * as a sandbox process, so it follows `cp` rules: existing files are
   * overwritten, and a destination that is an existing directory receives the
   * source inside it. With `noOverwrite`, one sandbox API request copies with
   * exclusive creates and leaves an existing final target unchanged.
   *
   * @param source - Absolute path to copy.
   * @param destination - Absolute target path.
   * @param options - `maxWait`: milliseconds to wait for the copy, default 180000 (3 minutes). The copy keeps running if the wait runs out.
   * `noOverwrite`: fail with `SandboxFileExistsError` instead of overwriting; entries created before a failure remain.
   * @returns The source and destination paths.
   * @throws When `cp` fails (the message includes its output) or does not finish within `maxWait`;
   * `SandboxFileExistsError` with `noOverwrite` when the final target exists.
   */
  async cp(source: string, destination: string, { maxWait = 180000, noOverwrite = false }: { maxWait?: number; noOverwrite?: boolean } = {}): Promise<CopyResponse> {
    if (noOverwrite) {
      return this.copyNoOverwrite(source, destination, maxWait);
    }
    // Quote both paths so the shell that runs this command treats them as
    // single literal arguments instead of interpreting metacharacters in them.
    let process = await this.process.exec({
      command: `cp -r ${shellQuote(source)} ${shellQuote(destination)}`,
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

  // One request: the sandbox API copies with exclusive creates and answers 409
  // FILE_ALREADY_EXISTS when the final target exists. Not retried: a POST copy
  // may have created entries before a connection reset.
  // maxWait bounds the request like the default path's wait; -1 waits indefinitely.
  private async copyNoOverwrite(source: string, destination: string, maxWait: number): Promise<CopyResponse> {
    if (!source || !destination) {
      throw new RangeError("source and destination must be nonempty paths");
    }
    if (!Number.isFinite(maxWait) || (maxWait < 0 && maxWait !== -1)) {
      throw new RangeError("maxWait must be -1 or finite and non-negative");
    }
    const controller = new AbortController();
    const timeoutError = new Error(`Could not copy ${source} to ${destination} within ${maxWait} ms; the sandbox may still be copying`);
    const timeout = maxWait === -1 ? undefined : setTimeout(() => controller.abort(timeoutError), maxWait);
    let result;
    try {
      result = await this.client.post<CopyResponse, { code?: string; error?: string }>({
        url: "/filesystem-copy",
        body: { source, destination, noOverwrite: true },
        headers: { "Content-Type": "application/json" },
        baseUrl: this.url,
        signal: controller.signal,
      });
    } catch (error) {
      // Fetch implementations differ in what they reject with on abort.
      if (controller.signal.aborted) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const { response, data, error } = result;
    if (response.status === 409 && error?.code === "FILE_ALREADY_EXISTS") {
      throw new SandboxFileExistsError(source, destination, { cause: error });
    }
    if (response.status === 404 && !error?.code && !error?.error) {
      // An older sandbox API has no copy endpoint. Never fall back to an overwriting copy.
      throw new Error("cp with noOverwrite needs a newer sandbox API: this sandbox has no /filesystem-copy endpoint; update its image");
    }
    this.handleResponseError(response, data, error);
    return { message: "Files copied", source, destination };
  }

  /**
   * Watch a directory for changes and call `callback` for each event, until
   * `close()` is called. Only changes after the call are reported, with no
   * initial listing. Events arrive one at a time: the next waits for the
   * callback's promise.
   *
   * @param path - Directory to watch. Only its direct entries are watched;
   * end the path with `/**` to include subdirectories.
   * @param callback - Called with `op` (`CREATE`, `WRITE`, `REMOVE`, `RENAME`
   * or `CHMOD`, several may be joined with `|`), `path` (the directory) and
   * `name` (the entry), plus `content` when `withContent` is set.
   * @param options - `withContent`: read the file and pass its text as
   * `content` on `CREATE` and `WRITE` (undefined if the read fails);
   * `ignore`: substrings, an event whose full path contains one is skipped
   * (for example `["node_modules", ".git"]`); `onError`: called when the
   * watch stream fails, after which it stops.
   * @returns A handle whose `close()` stops watching.
   *
   * @example
   * ```typescript
   * const watcher = sandbox.fs.watch("/app/src/**", (event) => {
   *   console.log(event.op, `${event.path}/${event.name}`);
   * }, { withContent: false, ignore: ["node_modules"] });
   * // later
   * watcher.close();
   * ```
   */
  watch(
    path: string,
    callback: (fileEvent: WatchEvent) => void | Promise<void>,
    options?: {
      onError?: (error: Error) => void,
      /** Called on each server keepalive (every ~30s). Use it to detect a silent, dead stream. */
      onKeepalive?: () => void,
      /** Called when the server ends the stream without close() having been called. */
      onClose?: () => void,
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
          // On end of stream, flush the decoder and terminate a trailing line so it is not dropped.
          buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("[keepalive]")) {
              options?.onKeepalive?.();
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
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    };
    start().then(() => {
      if (!closed) {
        closed = true;
        options?.onClose?.();
      }
    }).catch((err: unknown) => {
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

  private async uploadFileWithMultipart(path: string, filePath: string, fileSize: number, permissions: string = "0644"): Promise<SuccessResponse> {
    if (!fs) {
      throw new Error("File streaming upload is only supported in Node.js environments");
    }

    const initResponse = await this.initiateMultipartUpload(path, permissions);
    const uploadId = initResponse.uploadId;

    if (!uploadId) {
      throw new Error("Failed to get upload ID from initiate response");
    }

    try {
      const numParts = Math.ceil(fileSize / CHUNK_SIZE);
      const parts: Array<MultipartPartInfo> = [];
      const fd = fs.openSync(filePath, 'r');

      try {
        for (let i = 0; i < numParts; i += MAX_PARALLEL_UPLOADS) {
          const batch: Array<Promise<MultipartUploadPartResponse>> = [];

          for (let j = 0; j < MAX_PARALLEL_UPLOADS && i + j < numParts; j++) {
            const partNumber = i + j + 1;
            const start = (partNumber - 1) * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileSize);
            const length = end - start;

            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, start);
            const chunk = new Blob([buffer]);

            batch.push(this.uploadPart(uploadId, partNumber, chunk));
          }

          const batchResults = await Promise.all(batch);
          parts.push(...batchResults);
        }
      } finally {
        fs.closeSync(fd);
      }

      parts.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));

      return await this.completeMultipartUpload(uploadId, parts);
    } catch (error) {
      try {
        await this.abortMultipartUpload(uploadId);
      } catch (abortError) {
        // Log but don't throw - we want to throw the original error
      }
      throw error;
    }
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

      // Keep a bounded worker queue full instead of waiting at fixed batch
      // boundaries. The upload gate remains authoritative across files; its
      // default of 2 also bounds this queue on H2.
      const h2UploadLimit = h2Domain ? settings.maxConcurrentUploadH2Requests : 0;
      const workerCount = Math.min(
        numParts,
        h2UploadLimit > 0 ? Math.min(MAX_PARALLEL_UPLOADS, h2UploadLimit) : MAX_PARALLEL_UPLOADS,
      );
      let nextPartNumber = 1;
      let stopped = false;
      let uploadError: unknown;

      const uploadNextPart = async (): Promise<void> => {
        while (!stopped) {
          const partNumber = nextPartNumber++;
          if (partNumber > numParts) return;

          const start = (partNumber - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, size);
          const chunk = blob.slice(start, end);

          // Slot acquired per-attempt inside the retry (see writeBinary): bounds
          // concurrent part streams, not retry sequences; freed during backoff.
          const doPart = () => this.uploadPart(uploadId, partNumber, chunk);
          const partWithSlot = h2Domain ? () => withUploadSlot(h2Domain, doPart) : doPart;
          try {
            parts.push(await retryOnTransient(partWithSlot));
          } catch (error) {
            if (!stopped) {
              stopped = true;
              uploadError = error;
            }
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => uploadNextPart()));
      if (stopped) {
        throw uploadError;
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
