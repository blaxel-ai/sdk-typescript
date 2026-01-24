# Blaxel TypeScript SDK

[Blaxel](https://blaxel.ai) is a perpetual sandbox platform that achieves near instant latency by keeping infinite secure sandboxes on automatic standby, while co-hosting your agent logic to cut network overhead.

This package contains helper functions for Blaxel's TypeScript SDK, to let you retrieve model clients and MCP tool definitions in the format required by LangChain/LangGraph.

## Example

```ts
import { blTools, blModel } from "@blaxel/langgraph";

const stream = await createReactAgent({
  llm: await blModel("sandbox-openai"),
  prompt: prompt,
  tools: [
    ...(await blTools(["blaxel-search", "webcrawl"])),
    tool(
      async (input: any) => {
        console.debug("TOOLCALLING: local weather", input);
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
```

## Installation

```bash
# npm
npm install @blaxel/langgraph

# pnpm
pnpm add @blaxel/langgraph

# yarn
yarn add @blaxel/langgraph

# bun
bun add @blaxel/langgraph
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

### Model use

Blaxel acts as a unified gateway for model APIs, centralizing access credentials, tracing and telemetry. You can integrate with any model API provider, or deploy your own custom model. When a model is deployed on Blaxel, a global API endpoint is also created to call it.

This package includes a helper function that creates a reference to a model deployed on Blaxel and returns a framework-specific model client that routes API calls through Blaxel's unified gateway.

```typescript
// With LangChain
import { blModel } from "@blaxel/langgraph";
const model = await blModel("claude-3-5-sonnet");
```

### MCP tool use

Blaxel lets you deploy and host Model Context Protocol (MCP) servers, accessible at a global endpoint over streamable HTTP.

This package includes a helper function that retrieves and returns tool definitions from a Blaxel-hosted MCP server in the format required by specific frameworks.

```typescript
// With LangChain
import { blTools } from "@blaxel/langgraph";
const tools = await blTools(['blaxel-search'])
```

### Telemetry

Instrumentation happens automatically when workloads run on Blaxel.

Enable automatic telemetry by importing the `@blaxel/telemetry` package:

```typescript
import "@blaxel/telemetry";
```

## Requirements

- Node.js v18 or later

## Documentation

- [Connect to MCP servers hosted on Blaxel](https://docs.blaxel.ai/Agents/Develop-an-agent-ts)
- [Connect to model APIs hosted on Blaxel](https://docs.blaxel.ai/Agents/Develop-an-agent-ts)

## Contributing

Contributions are welcome! Please feel free to [submit a pull request](https://github.com/blaxel-ai/sdk-typescript/pulls).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
