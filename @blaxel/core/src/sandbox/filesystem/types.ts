import { z } from "zod";

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

export const CpParamsSchema = z.object({
  source: z.string().describe("Source file or directory path"),
  destination: z.string().describe("Destination file or directory path"),
}).describe("Parameters for copying a file or directory");

export const MkdirParamsSchema = z.object({
  path: z.string().describe("Directory path to create"),
  permissions: z.string().optional().default("0755").describe("Permissions for the new directory (default 0755)"),
}).describe("Parameters for creating a directory");

export const LsParamsSchema = z.object({
  path: z.string().describe("Directory path to list"),
}).describe("Parameters for listing a directory");

export const RmParamsSchema = z.object({
  path: z.string().describe("File or directory path to remove"),
  recursive: z.boolean().optional().default(false).describe("Whether to remove recursively (default false)"),
}).describe("Parameters for removing a file or directory");

export const ReadParamsSchema = z.object({
  path: z.string().describe("File path to read"),
}).describe("Parameters for reading a file");

export const WriteParamsSchema = z.object({
  path: z.string().describe("File path to write to"),
  content: z.string().describe("Content to write to the file"),
}).describe("Parameters for writing to a file");

export type ToolWithoutExecute = {
  cp: {
    description: string;
    parameters: typeof CpParamsSchema;
  };
  mkdir: {
    description: string;
    parameters: typeof MkdirParamsSchema;
  };
  ls: {
    description: string;
    parameters: typeof LsParamsSchema;
  };
  rm: {
    description: string;
    parameters: typeof RmParamsSchema;
  };
  read: {
    description: string;
    parameters: typeof ReadParamsSchema;
  };
  write: {
    description: string;
    parameters: typeof WriteParamsSchema;
  };
}

export type ToolWithExecute = {
  cp: {
    description: string;
    parameters: typeof CpParamsSchema;
    execute: (args: z.infer<typeof CpParamsSchema>) => Promise<string>;
  };
  mkdir: {
    description: string;
    parameters: typeof MkdirParamsSchema;
    execute: (args: z.infer<typeof MkdirParamsSchema>) => Promise<string>;
  };
  ls: {
    description: string;
    parameters: typeof LsParamsSchema;
    execute: (args: z.infer<typeof LsParamsSchema>) => Promise<string>;
  };
  rm: {
    description: string;
    parameters: typeof RmParamsSchema;
    execute: (args: z.infer<typeof RmParamsSchema>) => Promise<string>;
  };
  read: {
    description: string;
    parameters: typeof ReadParamsSchema;
    execute: (args: z.infer<typeof ReadParamsSchema>) => Promise<string>;
  };
  write: {
    description: string;
    parameters: typeof WriteParamsSchema;
    execute: (args: z.infer<typeof WriteParamsSchema>) => Promise<string>;
  };
}
