
export type CopyResponse = {
  message: string;
  source: string;
  destination: string;
}

export type WatchEvent = {
  op: "CREATE" | "WRITE" | "REMOVE" | "RENAME" | "CHMOD";
  path: string;
  name: string;
  content?: string;
}

export type SandboxFilesystemFile = {
  path: string;
  content: string;
}

export interface FilesystemSearchOptions {
  maxResults?: number;
  patterns?: string[];
  excludeDirs?: string[];
  excludeHidden?: boolean;
}

export interface FilesystemFindOptions {
  type?: 'file' | 'directory';
  patterns?: string[];
  maxResults?: number;
  excludeDirs?: string[];
  excludeHidden?: boolean;
}

export type FilesystemReadTreeOptions = Pick<FilesystemFindOptions, "patterns" | "excludeHidden"> & {
  /**
   * Directory names to skip. A non-empty list replaces `find`'s default exclusions
   * (`node_modules`, `vendor`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.venv`,
   * `.next`, `coverage`), so list those you still want skipped.
   */
  excludeDirs?: string[];
  /** Reject instead of truncating when more files match. Default 100, at most 999. */
  maxFiles?: number;
  /** Maximum reads in flight. Default 4. */
  concurrency?: number;
};

export interface FilesystemGrepOptions {
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  filePattern?: string;
  excludeDirs?: string[];
}
