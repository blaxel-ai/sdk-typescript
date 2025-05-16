# Blaxel Typescript SDK

<p align="center">
  <img src="https://blaxel.ai/logo.png" alt="Blaxel"/>
</p>

**Blaxel is a computing platform for AI agent builders, with all the services and infrastructure to build and deploy agents efficiently.** This repository contains the TypeScript SDK to interact with Blaxel resources using Mastra format.


## Table of Contents

- [Installation](#installation)
  - [Optional libraries](#optional-libraries)
  - [Authentication](#authentication)
- [Features](#features)
- [Quickstart](#quickstart)
- [Contributing](#contributing)
- [License](#license)



## Installation

Install Blaxel SDK for Mastra, which lets you retrieve Blaxel resources in Mastra format.

```bash
## npm
npm install @blaxel/mastra

## pnpm
pnpm i @blaxel/mastra

## yarn
yarn add @blaxel/mastra
```


### Optional libraries
Blaxel SDK is split between multiple packages. *core* is the minimal package to connect to Blaxel. You can find other packages to help you integrate with your favorite AI framework, or set up telemetry.

- [@blaxel/telemetry](@blaxel/telemetry/README.md)
- [@blaxel/core](@blaxel/core/README.md)

Instrumentation happens automatically when workloads run on Blaxel. To enable telemetry, simply require the SDK in your project's entry point.
```ts
import "@blaxel/telemetry";
```


### Authentication

The Blaxel SDK authenticates with your workspace using credentials from these sources, in priority order:
1. When running on Blaxel, authentication is handled automatically
2. Variables in your .env file (`BL_WORKSPACE` and `BL_API_KEY`, or see [this page](https://docs.blaxel.ai/Agents/Variables-and-secrets) for other authentication options).
3. Environment variables from your machine
4. Configuration file created locally when you log in through Blaxel CLI (or deploy on Blaxel)

When developing locally, the recommended method is to just log in to your workspace with Blaxel CLI. This allows you to run Blaxel SDK functions that will automatically connect to your workspace without additional setup. When you deploy on Blaxel, this connection persists automatically.

When running Blaxel SDK from a remote server that is not Blaxel-hosted, we recommend using environment variables as described in the third option above.



## Features
- [Connect to MCP servers hosted on Blaxel](https://docs.blaxel.ai/Agents/Develop-an-agent-ts)
- [Connect to model APIs hosted on Blaxel](https://docs.blaxel.ai/Agents/Develop-an-agent-ts)


## Connect to MCP server tools and models on Blaxel

```ts
// With Mastra
import { blTools, blModel } from "@blaxel/mastra";

const agent = new Agent({
  name: "blaxel-agent-mastra",
  model: await blModel("gpt-4o-mini"),
  instructions: prompt,
  tools: {
    ...(await blTools(["blaxel-search", "webcrawl"])),
    weatherTool: createTool({
      id: "weatherTool",
      description: "Get the weather in a specific city",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        weather: z.string(),
      }),
      execute: async ({ context }) => {
        console.debug("TOOLCALLING: local weather", context);
        return `The weather in ${context.city} is sunny`;
      },
    }),
  },
});
const stream = await agent.stream([{ role: "user", content: process.argv[2] }]);

```


## Quickstart

Blaxel CLI gives you a quick way to create new applications: agents, MCP servers, jobs, etc - and deploy them to Blaxel.

**Prerequisites**:
- **Node.js:** v18 or later.
- **Blaxel CLI:** Make sure you have Blaxel CLI installed. If not, [install it](https://docs.blaxel.ai/cli-reference/introduction):
  ```bash
  curl -fsSL \
  https://raw.githubusercontent.com/blaxel-ai/toolkit/main/install.sh \
  | BINDIR=/usr/local/bin sudo -E sh
  ```
- **Blaxel login:** Login to Blaxel:
  ```bash
    bl login YOUR-WORKSPACE
  ```

```bash
bl create-agent-app myfolder
cd myfolder
bl deploy
```

Also available:
-  `bl create-mcp-server`
-  `bl create-job`



## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.



## License

This project is licensed under the MIT License - see the LICENSE file for details.
