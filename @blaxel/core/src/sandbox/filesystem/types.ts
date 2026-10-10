
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

export type FilesystemReadTreeOptions = Pick<FilesystemFindOptions, "patterns"> & {
  /** Directory names to skip, with everything below them. Default: none. */
  excludeDirs?: string[];
  /** Skip files and directories whose name starts with a dot. Default: false. */
  excludeHidden?: boolean;
  /** Reject instead of truncating when more files match. Default 10000, at most 100000. */
  maxFiles?: number;
  /** Reject when the matching files hold more bytes. Default 32 MiB, at most 256 MiB. */
  maxBytes?: number;
};

export interface FilesystemGrepOptions {
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  filePattern?: string;
  excludeDirs?: string[];
}
