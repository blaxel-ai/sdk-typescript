import z from "zod";

export type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  originalSchema: object;
  call(input: unknown): Promise<unknown>;
};