# Blaxel Typescript SDK

<p align="center">
  <img src="https://blaxel.ai/logo.png" alt="Blaxel"/>
</p>

An SDK to connect your agent or tools with Blaxel platform.
Currently in preview, feel free to send us feedback or contribute to the project.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Start from an hello world example](#start-from-an-hello-world-example)
- [Integrate with a custom code](#integrate-with-a-custom-code)
  - [Set-up blaxel observability](#set-up-blaxel-observability)
  - [Connect tools and model from blaxel platform to your agent](#connect-tools-and-model-from-blaxel-platform-to-your-agent)
  - [Agent Chaining](#agent-chaining)
  - [Deploy on blaxel](#deploy-on-blaxel)
  - [Advanced configuration](#advanced-configuration)
  - [Create an MCP Server](#create-an-mcp-server)
  - [Connect an existing MCP Server to blaxel](#connect-an-existing-mcp-server-to-blaxel)
  - [How to use environment variables or secrets](#how-to-use-environment-variables-or-secrets)
- [Contributing](#contributing)
- [License](#license)

## Features

Supported AI frameworks:

- Vercel AI
- LlamaIndex
- LangChain
- Mastra
  Supported Tools frameworks:
- MCP

## Prerequisites

- **Node.js:** v18 or later.
- **Blaxel CLI:** Ensure you have the Blaxel CLI installed. If not, install it globally:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/beamlit/toolkit/preview/install.sh | BINDIR=$HOME/.local/bin sh
  ```
- **Blaxel login:** Login to Blaxel platform
  ```bash
    bl login YOUR-WORKSPACE
  ```

## Start from an hello world example

```bash
bl create-agent-app myfolder
cd myfolder
bl serve --hotreload
```

## Integrate with a custom code

### Set-up blaxel observability

It only need a require of our SDK on top of your main entrypoint file.
It will directly plug our backend (when deployed on blaxel) with open telemetry standard.

```ts
import "@blaxel/sdk";
```

### Connect tools and model from blaxel platform to your agent

```ts
import { blTools, blModel } from "@blaxel/sdk";
```

Then you need to use it in your agent

```ts
// Example with llamaIndex
const stream = agent({
  llm: await blModel("gpt-4o-mini").ToLlamaIndex(),
  tools: [
    ...(await blTools(["blaxel-search", "webcrawl"]).ToLlamaIndex()),
    tool({
      name: "weather",
      description: "Get the weather in a specific city",
      parameters: z.object({
        city: z.string(),
      }),
      execute: async (input) => {
        logger.debug("TOOLCALLING: local weather", input);
        return `The weather in ${input.city} is sunny`;
      },
    }),
  ],
  systemPrompt: prompt,
}).run(process.argv[2]);

// With Vercel AI

const stream = streamText({
  model: await blModel("gpt-4o-mini").ToVercelAI(),
  messages: [{ role: "user", content: process.argv[2] }],
  system: prompt,
  tools: {
    ...(await blTools(["blaxel-search", "webcrawl"]).ToVercelAI()),
    weather: tool({
      description: "Get the weather in a specific city",
      parameters: z.object({
        city: z.string(),
      }),
      execute: async (input) => {
        logger.debug("TOOLCALLING: local weather", input);
        return `The weather in ${input.city} is sunny`;
      },
    }),
  },
  maxSteps: 5,
});

// With LangChain
const stream = await createReactAgent({
  llm: await blModel("gpt-4o-mini").ToLangChain(),
  prompt: prompt,
  tools: [
    ...(await blTools(["blaxel-search", "webcrawl"]).ToLangChain()),
    tool(
      async (input: any) => {
        logger.debug("TOOLCALLING: local weather", input);
        return `The weather in ${input.city} is sunny`;
      },
      {
        name: "weather",
        description: "Get the weather in a specific city",
        schema: z.object({
          city: z.string(),
        }),
      }
    ),
  ],
}).stream({
  messages: [new HumanMessage(process.argv[2])],
});

// With Mastra
const agent = new Agent({
  name: "blaxel-agent-mastra",
  model: await blModel("gpt-4o-mini").ToMastra(),
  instructions: prompt,
  tools: {
    ...(await blTools(["blaxel-search", "webcrawl"]).ToMastra()),
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
        logger.debug("TOOLCALLING: local weather", context);
        return `The weather in ${context.city} is sunny`;
      },
    }),
  },
});
const stream = await agent.stream([{ role: "user", content: process.argv[2] }]);
```

### Agent Chaining

You can call an agent from another agent to chain them.
This allow complexe agentic logic, with multiple agents calling each other, orchestration, routing, etc.

```ts
// Example of call of an agent, then put his result inside a second one

// First agent, which is a simple one
// He will expose himself with an endpoint (can be done with getting started example)
// POST / {input: string}
export default async function agent(input: string): Promise<any> {
  const firstResponse = await generateObject({
    experimental_telemetry: { isEnabled: true },
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    system:
      "You are a first point of contact for a loan company. Your job is to turn client conversation into loan application.",
    schema: z.object({
      name: z.string(),
      loan_amount: z.number(),
      loan_time_in_months: z.number(),
      monthly_income: z.number(),
    }),
    messages: [
      {
        role: "user",
        content: input,
      },
    ],
  });

  return firstResponse.object;
}

// Second agent, which will call the first one, then do another processing
export default async function agent(input: string): Promise<any> {
  let firstResponse = await blAgent("vercel-first").run({
    inputs: input,
  });
  const gateResponse = await generateObject({
    experimental_telemetry: { isEnabled: true },
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    system:
      "You are a loan specialist. Based on the given json file with client data, your job is to decide if a client can be further processed.",
    schema: z.object({
      is_client_accepted: z.boolean(),
      denial_reason: z
        .string()
        .optional()
        .describe("If client is rejected, you need to give a reason."),
    }),
    messages: [{ role: "user", content: firstResponse }],
  });
  return gateResponse.object;
}
```

You can also set an agent as a tool, depending of framework you use.

```ts
// In this example, we call the first agent as a tool, you can use the example above to expose the first one
import { blAgent, blModel, blTools, logger } from "@blaxel/sdk";
import { streamText, tool } from "ai";
import { z } from "zod";

interface Stream {
  write: (data: string) => void;
  end: () => void;
}

export default async function agent(
  input: string,
  stream: Stream
): Promise<void> {
  const response = streamText({
    experimental_telemetry: { isEnabled: true },
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    tools: {
      ...(await blTools(["blaxel-search"]).ToVercelAI()),
      "vercel-first": tool({
        description: "Get a json for load from input",
        parameters: z.object({
          input: z.string(),
        }),
        execute: async (args: { input: string }) => {
          return await blAgent("vercel-first").run(args.input);
        },
      }),
      weather: tool({
        description: "Get the weather in a specific city",
        parameters: z.object({
          city: z.string(),
        }),
        execute: async (args: { city: string }) => {
          logger.debug("TOOLCALLING: local weather", args);
          return `The weather in ${args.city} is sunny`;
        },
      }),
    },
    system: "If the user ask for the weather, use the weather tool.",
    messages: [{ role: "user", content: input }],
    maxSteps: 5,
  });

  for await (const delta of response.textStream) {
    stream.write(delta);
  }
  stream.end();
}
```

### Deploy on blaxel

To deploy on blaxel, we have only one requirement in each agent code.
We need an HTTP Server

For example with expressjs we will have this configuration

```ts
const port = parseInt(process.env.BL_SERVER_PORT || "3000");
const host = process.env.BL_SERVER_HOST || "0.0.0.0";

app.listen(port, host, () => {
  logger.info(`Server is running on port ${host}:${port}`);
});
```

You can provide any endpoint you want, it will be serve directly.

Not mandatory: For using our playground UI (or chat UI) we have a standard endpoint :

POST /
data: {
"inputs": "User input as string"
}

With expressjs it will be for example:

```ts
app.post("/", async (req: express.Request, res: express.Response) => {
  const inputs = req.body.inputs;
  // My agentic logic here, inputs will be a string
  res.send("A string output");
});
```

```bash
bl deploy
```

### Advanced configuration

You can add optionally a configuration file "blaxel.toml" in your project root.

```toml
name = "my-agent"
workspace = "my-workspace"
type = "agent"

functions = ["blaxel-search"]
models = ["sandbox-openai"]
```

It allow to customize the requirements for your agent, it can be usefull if you have many models and functions in your workspace.

### Create an MCP Server

If you want to create an MCP Server for using it in multiple agents, you can bootstrap it with the following command:

```bash
bl create-mcp-server my-mcp-server
cd my-mcp-server
bl serve --hotreload
```

We follow current standard for tool development over MCP Server.
Example of a tool which is sending fake information about the weather:

```ts
import { BlaxelMcpServerTransport, logger } from "@blaxel/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "Weather",
  version: "1.0.0",
  description: "A demo mcp server",
});

server.tool(
  "weather_by_city",
  "Get the weather for a city",
  {
    city: z.string(),
  },
  async ({ city }) => {
    logger.info(`Weather in ${city}`);
    return {
      content: [{ type: "text", text: `The weather in ${city} is sunny` }],
    };
  }
);

function main() {
  let transport;
  if (process.env.BL_SERVER_PORT) {
    transport = new BlaxelMcpServerTransport();
  } else {
    transport = new StdioServerTransport();
  }
  server.connect(transport);
  logger.info("Server started");
}

main();
```

### Connect an existing MCP Server to blaxel

You need to have a "blaxel.toml" file in your project root

```toml
name = "weather"
workspace = "my-workspace"
type = "function"
```

Connect the observability layer

```ts
import "@blaxel/sdk";
```

Load blaxel transport

```ts
import { BlaxelMcpServerTransport } from "@blaxel/sdk";
```

Update your entrypoint to support our transport instead of StdioServerTransport

```ts
// You can easily keep your MCP working locally with a simple if on our prod variable
function main() {
  let transport;
  if (process.env.BL_SERVER_PORT) {
    transport = new BlaxelMcpServerTransport();
  } else {
    transport = new StdioServerTransport();
  }
  server.connect(transport);
  logger.info("Server started");
}
```

### How to use environment variables or secrets

You can use the "blaxel.toml" config file to specify environment variables for your agent.

```toml
name = "weather"
workspace = "my-workspace"
type = "function"

[env]
DEFAULT_CITY = "San Francisco"

```

Then you can use it in your agent or function with the following syntax:

```ts
import { env } from "@blaxel/sdk";
console.log(env.DEFAULT_CITY); // San Francisco
```

You can also add secrets variables to a .env files in your project root. (goal is to not commit this file)

Example of a .env file:

```
# Secret variables can be store here
DEFAULT_CITY_PASSWORD=123456
```

Then you can use it in your agent or function with the following syntax:

```ts
import { env } from "@blaxel/sdk";
console.log(env.DEFAULT_CITY_PASSWORD); // 123456
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
