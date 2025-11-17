import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { blModel } from "@blaxel/mastra";
import { SandboxInstance } from "@blaxel/core";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Stream {
  write: (data: string) => void;
  end: () => void;
}

/**
 * Code Execution Agent with Mastra
 *
 * This agent follows the code execution pattern described in:
 * https://www.anthropic.com/engineering/code-execution-with-mcp
 *
 * Instead of loading all tool definitions upfront, the agent generates
 * code that executes in a Blaxel sandbox, using tools on-demand.
 */
export class CodeExecutionAgent {
  private agent!: Agent;
  private sandbox!: SandboxInstance;
  private sandboxName: string;
  private modelName: string;
  private initialized: boolean = false;

  constructor(sandboxName: string, modelName: string = "claude-sonnet-4-5") {
    this.sandboxName = sandboxName;
    this.modelName = modelName;
  }

  private async ensureInitialized() {
    if (!this.initialized) {
      await this.initializeAgent(this.modelName);
      this.initialized = true;
    }
  }

  private async initializeAgent(modelName: string) {
    // Prepare environment variables for sandbox
    const envs = [
      { name: "AWS_REGION", value: process.env.AWS_REGION || "" },
      { name: "AWS_ACCESS_KEY_ID", value: process.env.AWS_ACCESS_KEY_ID || "" },
      { name: "AWS_SECRET_ACCESS_KEY", value: process.env.AWS_SECRET_ACCESS_KEY || "" },
      { name: "OPENAI_API_KEY", value: process.env.OPENAI_API_KEY || "" },
      { name: "TELEGRAM_CHAT_ID", value: process.env.TELEGRAM_CHAT_ID || "" },
      { name: "TELEGRAM_TOKEN", value: process.env.TELEGRAM_TOKEN || "" },
    ];

    // Create or get sandbox with environment variables
    this.sandbox = await SandboxInstance.createIfNotExists({
      name: this.sandboxName,
      image: "blaxel/base-image:latest",
      memory: 4096,
      ports: [{ target: 3000, protocol: "HTTP" }],
      envs: envs,
    });

    // Populate sandbox with tool definitions (following article's pattern)
    await this.populateToolDefinitions();

    // Create a code generation tool that writes and executes code in the sandbox
    const generateAndExecuteCodeTool = createTool({
      id: "generateAndExecuteCode",
      description: `Generate TypeScript/JavaScript code and execute it in the Blaxel sandbox.

This tool allows you to write code that will run in the sandbox environment.
The code can use any Node.js APIs and can interact with the filesystem, network, etc.
Returns the execution result and any console output.`,
      inputSchema: z.object({
        code: z.string().describe("The TypeScript or JavaScript code to execute"),
        description: z.string().optional().describe("Brief description of what the code does"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        output: z.string(),
        error: z.string().optional(),
      }),
      execute: async ({ context }) => {
        try {
          // Write code to a temporary file in root directory for easier tool imports
          const fileName = `/code-${Date.now()}.ts`;
          await this.sandbox.fs.write(fileName, context.code);

          // Execute the code using Node.js
          // Use tsx to run TypeScript directly, and set working directory to root for tool imports
          const process = await this.sandbox.process.exec({
            name: `code-exec-${Date.now()}`,
            command: `cd / && npx tsx ${fileName}`,
            waitForCompletion: true,
            workingDir: "/",
          });

          const logs = await this.sandbox.process.logs(process.pid!, "all");

          return {
            success: process.status === "completed",
            output: logs || "",
            error: process.status === "failed" ? `Exit code: ${process.exitCode}` : undefined,
          };
        } catch (error: any) {
          return {
            success: false,
            output: "",
            error: error.message || String(error),
          };
        }
      },
    });

    // Create tool to read files from sandbox
    const readFileTool = createTool({
      id: "readSandboxFile",
      description: "Read a file from the sandbox filesystem",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to read"),
      }),
      outputSchema: z.object({
        content: z.string(),
        exists: z.boolean(),
      }),
      execute: async ({ context }) => {
        try {
          const content = await this.sandbox.fs.read(context.path);
          return { content: content || "", exists: true };
        } catch (error: any) {
          return { content: "", exists: false };
        }
      },
    });

    // Create tool to write files to sandbox
    const writeFileTool = createTool({
      id: "writeSandboxFile",
      description: "Write content to a file in the sandbox filesystem",
      inputSchema: z.object({
        path: z.string().describe("Path where to write the file"),
        content: z.string().describe("Content to write to the file"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      execute: async ({ context }) => {
        try {
          await this.sandbox.fs.write(context.path, context.content);
          return { success: true, message: `File written to ${context.path}` };
        } catch (error: any) {
          return { success: false, message: error.message || String(error) };
        }
      },
    });

    // Create tool to list directory contents
    const listDirectoryTool = createTool({
      id: "listSandboxDirectory",
      description: "List files and directories in a sandbox directory",
      inputSchema: z.object({
        path: z.string().describe("Path to the directory to list"),
      }),
      outputSchema: z.object({
        files: z.array(z.string()),
        directories: z.array(z.string()),
      }),
      execute: async ({ context }) => {
        try {
          const listing = await this.sandbox.fs.ls(context.path);
          return {
            files: listing.files?.map((f: any) => f.name) || [],
            directories: listing.subdirectories?.map((d: any) => d.name) || [],
          };
        } catch (error: any) {
          return { files: [], directories: [] };
        }
      },
    });

    // Create tool to execute shell commands
    const executeCommandTool = createTool({
      id: "executeSandboxCommand",
      description: "Execute a shell command in the sandbox",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        workingDir: z.string().optional().describe("Working directory for the command"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        output: z.string(),
        exitCode: z.number().optional(),
      }),
      execute: async ({ context }) => {
        try {
          const process = await this.sandbox.process.exec({
            name: `cmd-${Date.now()}`,
            command: context.command,
            waitForCompletion: true,
            workingDir: context.workingDir,
          });
          const logs = await this.sandbox.process.logs(process.pid!, "all");
          return {
            success: process.status === "completed",
            output: logs || "",
            exitCode: process.exitCode,
          };
        } catch (error: any) {
          return {
            success: false,
            output: error.message || String(error),
            exitCode: -1,
          };
        }
      },
    });

    // Initialize the agent with model and tools
    // Following the code execution pattern: we provide high-level tools
    // that generate code, rather than exposing all sandbox tools directly
    this.agent = new Agent({
      name: "code-execution-agent",
      model: await blModel(modelName),
      tools: {
        // High-level code execution tool (primary tool following code execution pattern)
        generateAndExecuteCode: generateAndExecuteCodeTool,
        // File system tools for code generation workflow
        readSandboxFile: readFileTool,
        writeSandboxFile: writeFileTool,
        listSandboxDirectory: listDirectoryTool,
        executeSandboxCommand: executeCommandTool,
      },
      instructions: `You are a code execution agent that generates and runs code in a Blaxel sandbox environment.

Your primary approach is to:
1. Discover available tools by exploring the /tools directory in the sandbox
2. Generate TypeScript/JavaScript code that imports and uses these tools
3. Execute that code in the sandbox using the generateAndExecuteCode tool
4. Use file operations to read/write code files as needed

This follows the code execution pattern where you write code to accomplish tasks
rather than making many individual tool calls. This is more efficient and allows
you to handle complex logic, loops, conditionals, and data transformations in a
single execution step.

Available tools are located in /tools directory:
- /tools/s3/ - AWS S3 tools (listFiles, readFile)
- /tools/dall-e/ - DALL-E image generation tools (generateImage)
- /tools/telegram/ - Telegram Bot API tools (sendMessage, sendPhoto)

To use these tools in your generated code:
1. Import them: import * as s3 from '/tools/s3/index.js';
2. Import them: import * as dalle from '/tools/dall-e/index.js';
3. Import them: import * as telegram from '/tools/telegram/index.js';
4. Use them in your code: const files = await s3.listFiles({ bucket: 'my-bucket', extension: '.txt' });

When generating code:
- Write clear, well-commented code
- Handle errors appropriately
- Use console.log() to output results
- Use async/await for asynchronous operations
- Import tools from /tools directory using absolute paths (/tools/...)
- The code will run from root directory (/), so use '/tools/...' to access tools

Example workflows:

1. S3 + DALL-E + Telegram:
Use: import * as s3 from '/tools/s3/index.js';
     import * as dalle from '/tools/dall-e/index.js';
     import * as telegram from '/tools/telegram/index.js';
     const files = await s3.listFiles({ bucket: 'my-bucket', extension: '.txt' });
     for (const file of files.files) {
       const content = (await s3.readFile({ bucket: 'my-bucket', key: file.key })).content;
       const image = await dalle.generateImage({ prompt: 'Create an image based on: ' + content.substring(0, 200), size: '1024x1024' });
       await telegram.sendMessage({ chatId: '@my_channel', text: 'File: ' + file.key + ' Content preview: ' + content.substring(0, 100) });
       await telegram.sendPhoto({ chatId: '@my_channel', photoUrl: image.imageUrl, caption: 'Generated image for ' + file.key });
     }

Remember: Generate code to accomplish tasks efficiently rather than chaining many tool calls.
This approach reduces token usage significantly (98.7% reduction as shown in the article).`,
    });
  }

  async run(input: string, stream?: Stream): Promise<string> {
    await this.ensureInitialized();

    if (stream) {
      const response = await this.agent.stream([
        { role: "user", content: input },
      ]);

      for await (const delta of response.textStream) {
        stream.write(delta);
      }
      stream.end();
      return "";
    } else {
      const response = await this.agent.generate([
        { role: "user", content: input },
      ]);
      return response.text;
    }
  }

  async getSandbox(): Promise<SandboxInstance> {
    await this.ensureInitialized();
    return this.sandbox;
  }

  /**
   * Populate the sandbox with tool definitions following the article's pattern
   * Creates a tar archive of the tools folder, uploads it, and untars it in the sandbox
   */
  private async populateToolDefinitions() {
    const toolsDir = path.join(__dirname, "tools");
    const sandboxToolsPath = "/tools";
    const tarPath = "/tmp/tools.tar";

    // Create package.json for tools if it doesn't exist
    const packageJsonPath = path.join(toolsDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.stringify({
        name: "tools",
        version: "1.0.0",
        type: "module",
      }, null, 2);
      fs.writeFileSync(packageJsonPath, packageJson);
    }

    // Create tar archive of the tools directory
    const tarBuffer = await this.createTarArchive(toolsDir);

    // Upload tar archive to sandbox using writeBinary
    await this.sandbox.fs.writeBinary(tarPath, tarBuffer);

    // Untar the archive in the sandbox
    await this.sandbox.process.exec({
      name: "untar-tools",
      command: `cd / && tar -xf ${tarPath} && rm ${tarPath}`,
      waitForCompletion: true,
      workingDir: "/",
    });
  }

  /**
   * Create a tar archive of a directory using system tar command
   */
  private async createTarArchive(sourceDir: string): Promise<Buffer> {
    const tempTarPath = path.join(tmpdir(), `tools-${Date.now()}.tar`);
    const parentDir = path.dirname(sourceDir);
    const dirName = path.basename(sourceDir);

    try {
      // Use system tar command to create archive
      execSync(`tar -cf "${tempTarPath}" -C "${parentDir}" "${dirName}"`, {
        stdio: "ignore",
      });

      // Read the tar file as buffer
      const buffer = fs.readFileSync(tempTarPath);

      // Clean up temp file
      fs.unlinkSync(tempTarPath);

      return buffer;
    } catch (error: any) {
      // Clean up temp file on error
      if (fs.existsSync(tempTarPath)) {
        fs.unlinkSync(tempTarPath);
      }
      throw new Error(`Failed to create tar archive: ${error.message}`);
    }
  }

}

