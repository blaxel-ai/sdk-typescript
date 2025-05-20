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

export type ToolWithoutExecute = {
  cp: {
    description: string;
    parameters: z.ZodObject<{
      source: z.ZodString;
      destination: z.ZodString;
    }>;
  };
  mkdir: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
      permissions: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    }>;
  };
  ls: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
  };
  rm: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
  };
  read: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
  };
  write: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
  };
}

export type ToolWithExecute = {
  cp: {
    description: string;
    parameters: z.ZodObject<{
      source: z.ZodString;
      destination: z.ZodString;
    }>;
    execute: (args: { source: string; destination: string }) => Promise<string>;
  };
  mkdir: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
      permissions: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    }>;
    execute: (args: { path: string; permissions: string }) => Promise<string>;
  };
  ls: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
    execute: (args: { path: string }) => Promise<string>;
  };
  rm: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
      recursive: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    }>;
    execute: (args: { path: string; recursive: boolean }) => Promise<string>;
  };
  read: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
    }>;
    execute: (args: { path: string }) => Promise<string>;
  };
  write: {
    description: string;
    parameters: z.ZodObject<{
      path: z.ZodString;
      content: z.ZodString;
    }>;
    execute: (args: { path: string; content: string }) => Promise<string>;
  };
}
