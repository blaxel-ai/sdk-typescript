
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