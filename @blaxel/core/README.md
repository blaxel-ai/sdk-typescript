# Blaxel TypeScript SDK

[Blaxel](https://blaxel.ai) is a perpetual sandbox platform that achieves near instant latency by keeping infinite secure sandboxes on automatic standby, while co-hosting your agent logic to cut network overhead.

This repository contains Blaxel's TypeScript SDK, which lets you create and manage sandboxes and other resources on Blaxel.

## Installation

```bash
# npm
npm install @blaxel/core

# yarn
yarn add @blaxel/core

# bun
bun add @blaxel/core
```

## Authentication

The SDK authenticates with your Blaxel workspace using these sources (in priority order):

1. Blaxel CLI, when logged in
2. Environment variables in `.env` file (`BL_WORKSPACE`, `BL_API_KEY`)
3. System environment variables
4. Blaxel configuration file (`~/.blaxel/config.yaml`)

When developing locally, the recommended method is to just log in to your workspace with the Blaxel CLI:

```bash
bl login YOUR-WORKSPACE
```

This allows you to run Blaxel SDK functions that will automatically connect to your workspace without additional setup. When you deploy on Blaxel, this connection persists automatically.

When running Blaxel SDK from a remote server that is not Blaxel-hosted, we recommend using environment variables as described in the third option above.

## Usage

### Sandboxes

Sandboxes are secure, instant-launching compute environments that scale to zero after inactivity and resume in under 25ms.

```typescript
import { SandboxInstance } from "@blaxel/core";

// Create a new sandbox
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest",
  memory: 4096,
  region: "us-pdx-1",
  ports: [{ target: 3000, protocol: "HTTP" }],
  labels: { env: "dev", project: "my-project" },
  ttl: "24h"
});

// Get existing sandbox
const existing = await SandboxInstance.get("my-sandbox");

// Delete sandbox (using class)
await SandboxInstance.delete("my-sandbox");

// Delete sandbox (using instance)
await existing.delete();
```

#### Preview URLs

Generate public preview URLs to access services running in your sandbox:

```typescript
import { SandboxInstance } from "@blaxel/core";

// Get existing sandbox
const sandbox = await SandboxInstance.get("my-sandbox");

// Start a web server in the sandbox
await sandbox.process.exec({
  command: "npm run dev -- --port 3000",
  workingDir: "/app",
  waitForPorts: [3000]
});

// Create a public preview URL
const preview = await sandbox.previews.createIfNotExists({
  metadata: { name: "app-preview" },
  spec: {
    port: 3000,
    public: true
  }
});

console.log(preview.spec?.url); // https://xyz.preview.bl.run
```

Previews can also be private, with or without a custom prefix. When you create a private preview URL, a [token](https://docs.blaxel.ai/Sandboxes/Preview-url#private-preview-urls) is required to access the URL, passed as a request parameter or request header.

```typescript
// ...

// Create a private preview URL
const privatePreview = await sandbox.previews.createIfNotExists({
  metadata: { name: "private-app-preview" },
  spec: {
    port: 3000,
    public: false
  }
});

// Create a public preview URL with a custom prefix
const customPreview = await sandbox.previews.createIfNotExists({
  metadata: { name: "custom-app-preview" },
  spec: {
    port: 3000,
    prefixUrl: "my-app",
    public: true
  }
});
```

#### Process execution

Execute and manage processes in your sandbox:

```typescript
import { SandboxInstance } from "@blaxel/core";

// Get existing sandbox
const sandbox = await SandboxInstance.get("my-sandbox");

// Execute a command
const process = await sandbox.process.exec({
  name: "build-process",
  command: "npm run build",
  workingDir: "/app",
  waitForCompletion: true,
  timeout: 60000 // 60 seconds
});

// Kill a running process
await sandbox.process.kill("build-process");
```

Restart a process if it fails, up to a maximum number of restart attempts:

```typescript
// ...

// Run with auto-restart on failure
process = await sandbox.process.exec({
  name: "web-server",
  command: "npm run dev -- --host 0.0.0.0 --port 3000",
  restartOnFailure: true,
  maxRestarts: 5
});
```

#### Filesystem operations

Manage files and directories within your sandbox:

```typescript
import { SandboxInstance } from "@blaxel/core";
import * as fs from "fs";

// Get existing sandbox
const sandbox = await SandboxInstance.get("my-sandbox");

// Write and read text files
await sandbox.fs.write("/app/config.json", '{"key": "value"}');
const content = await sandbox.fs.read("/app/config.json");

// Write and read binary files
const binaryData = fs.readFileSync("./image.png");
await sandbox.fs.writeBinary("/app/image.png", binaryData);
const blob = await sandbox.fs.readBinary("/app/image.png");

// Create directories
await sandbox.fs.mkdir("/app/uploads");

// List files
const { subdirectories, files } = await sandbox.fs.ls("/app");

// Search for text within files
const matches = await sandbox.fs.grep("pattern", "/app", {
  caseSensitive: true,
  contextLines: 2,
  maxResults: 5,
  filePattern: "*.ts",
  excludeDirs: ["node_modules"]
});

// Find files and directories matching specified patterns:
const results = await sandbox.fs.find("/app", {
  type: "file",
  patterns: ["*.md", "*.html"],
  maxResults: 1000
});

// Watch for file changes
const handle = sandbox.fs.watch("/app", (event) => {
  console.log(event.op, event.path);
}, {
  withContent: true,
  ignore: ["node_modules", ".git"]
});

// Close watcher
handle.close();
```

#### Volumes

Persist data by attaching and using volumes:

```typescript
import { VolumeInstance, SandboxInstance } from "@blaxel/core";

// Create a volume
const volume = await VolumeInstance.createIfNotExists({
  name: "my-volume",
  size: 1024, // MB
  region: "us-pdx-1",
  labels: {  env: "test", project: "12345"  }
});

// Attach volume to sandbox
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest",
  volumes: [
    { name: "my-volume", mountPath: "/data", readOnly: false }
  ]
});

// List volumes
const volumes = await VolumeInstance.list();

// Delete volume (using class)
await VolumeInstance.delete("my-volume");

// Delete volume (using instance)
await volume.delete();
```

### Batch jobs

Blaxel lets you support agentic workflows by offloading asynchronous batch processing tasks to its scalable infrastructure, where they can run in parallel. Jobs can run multiple times within a single execution and accept optional input parameters.

```typescript
import { blJob } from "@blaxel/core";

// Create and run a job execution
const job = blJob("job-name");

const executionId = await job.createExecution({
  tasks: [
    { name: "John" },
    { name: "Jane" },
    { name: "Bob" }
  ]
});

// Get execution status
// Returns: "pending" | "running" | "completed" | "failed"
const status = await job.getExecutionStatus(executionId);

// Get execution details
const execution = await job.getExecution(executionId);
console.log(execution.status, execution.metadata);

// Wait for completion
try {
  const result = await job.waitForExecution(executionId, {
    maxWait: 300000,  // 5 minutes (milliseconds)
    interval: 2000,   // Poll every 2 seconds (milliseconds)
  });
  console.log(`Completed: ${result.status}`);
} catch (error) {
  console.log(`Timeout: ${error.message}`);
}

// List all executions
const executions = await job.listExecutions();

// Delete an execution
await job.deleteExecution(executionId);
```

### Framework integrations

Blaxel provides additional packages for framework-specific integrations and telemetry:

- [`@blaxel/telemetry`](./@blaxel/telemetry/README.md) - OpenTelemetry instrumentation
- [`@blaxel/vercel`](./@blaxel/vercel/README.md) - Vercel AI SDK integration
- [`@blaxel/llamaindex`](./@blaxel/llamaindex/README.md) - LlamaIndex integration
- [`@blaxel/langgraph`](./@blaxel/langgraph/README.md) - LangGraph integration
- [`@blaxel/mastra`](./@blaxel/mastra/README.md) - Mastra integration

#### Model use

Blaxel acts as a unified gateway for model APIs, centralizing access credentials, tracing and telemetry. You can integrate with any model API provider, or deploy your own custom model. When a model is deployed on Blaxel, a global API endpoint is also created to call it.

The SDK includes a helper function that creates a reference to a model deployed on Blaxel and returns a framework-specific model client that routes API calls through Blaxel's unified gateway.

```typescript
import { blModel } from "@blaxel/core";

// With Vercel AI SDK
import { blModel } from "@blaxel/vercel";
const model = await blModel("gpt-5-mini");

// With LangChain
import { blModel } from "@blaxel/langgraph";
const model = await blModel("gpt-5-mini");

// With LlamaIndex
import { blModel } from "@blaxel/llamaindex";
const model = await blModel("gpt-5-mini");

// With Mastra
import { blModel } from "@blaxel/mastra";
const model = await blModel("gpt-5-mini");
```

#### MCP tool use

Blaxel lets you deploy and host Model Context Protocol (MCP) servers, accessible at a global endpoint over streamable HTTP.

The SDK includes a helper function that retrieves and returns tool definitions from a Blaxel-hosted MCP server in the format required by specific frameworks.

```typescript
// With Vercel AI SDK
import { blTools } from "@blaxel/vercel";
const tools = await blTools(['sandbox/my-sandbox'])

// With Mastra
import { blTools } from "@blaxel/mastra";
const tools = await blTools(['sandbox/my-sandbox'])

// With LlamaIndex
import { blTools } from "@blaxel/llamaindex";
const tools = await blTools(['sandbox/my-sandbox'])

// With LangChain
import { blTools } from "@blaxel/langgraph";
const tools = await blTools(['sandbox/my-sandbox'])
```

Here is an example of retrieving tool definitions from a Blaxel sandbox's MCP server in the format required by Vercel's AI SDK:

```typescript
import { SandboxInstance } from "@blaxel/core";
import { blTools } from "@blaxel/vercel";

// Create a new sandbox
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest",
  memory: 4096,
  region: "us-pdx-1",
  ttl: "24h"
});

// Get sandbox tools
const tools = await blTools(['sandbox/my-sandbox'])
```

### Telemetry

Instrumentation happens automatically when workloads run on Blaxel.

Enable automatic telemetry by importing the `@blaxel/telemetry` package:

```typescript
import "@blaxel/telemetry";
```

## Requirements

- Node.js v18 or later

## Contributing

Contributions are welcome! Please feel free to [submit a pull request](https://github.com/blaxel-ai/sdk-typescript/pulls).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
