# Blaxel Typescript SDK

<p align="center">
  <img style="max-width: 300px;" src="https://blaxel.ai/logo.png" alt="Blaxel"/>
</p>

An SDK to connect your agent or tools with Blaxel platform.
Currently in preview, feel free to send us feedback or contribute to the project.

## Table of Contents
- [Features](#features)
- [Example Results](#example-results)
  - [URL-based Post Generation](#url-based-post-generation)
  - [Theme-based Post Generation](#theme-based-post-generation)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Development](#local-development)
  - [Deployment to Blaxel](#deployment-to-blaxel)
- [Project Structure](#project-structure)
- [Customization](#customization)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

## Features
Supported AI frameworks:
- Vercel AI
- LlamaIndex
- LangChain
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
import { blTools, blModel } from '@blaxel/sdk';
```

Then you need to use it in your agent
```ts
  // Example with llamaIndex
  const stream = agent({
    llm: await blModel("gpt-4o-mini").ToLlamaIndex(),
    tools: [...await blTools(['blaxel-search','webcrawl']).ToLlamaIndex(),
      tool({
        name: "weather",
        description: "Get the weather in a specific city",
        parameters: z.object({
          city: z.string(),
        }),
        execute: async (input) => {
          logger.debug("TOOLCALLING: local weather", input)
          return `The weather in ${input.city} is sunny`;
        },
      })
    ],
    systemPrompt: prompt,
  }).run(process.argv[2]);

  // With Vercel AI

  const stream = streamText({
    model: await blModel("gpt-4o-mini").ToVercelAI(),
    messages: [
      { role: 'user', content: process.argv[2] }
    ],
    system: prompt,
    tools: {
      ...await blTools(['blaxel-search','webcrawl']).ToVercelAI(),
      "weather": tool({
        description: "Get the weather in a specific city",
        parameters: z.object({
          city: z.string(),
        }),
        execute: async (input) => {
          logger.debug("TOOLCALLING: local weather", input)
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
      ...await blTools(['blaxel-search','webcrawl']).ToLangChain(),
      tool(async (input: any) => {
        logger.debug("TOOLCALLING: local weather", input)
        return `The weather in ${input.city} is sunny`;
      },{
        name: "weather",
        description: "Get the weather in a specific city",
        schema: z.object({
          city: z.string(),
        })
      })
    ],
  }).stream({
    messages: [new HumanMessage(process.argv[2])],
  });
```


### Deploy on blaxel

To deploy on blaxel, we have only one requirement in your code.
We need an HTTP Server

For example with expressjs we will have this configuration

```ts
  const port = parseInt(process.env.BL_SERVER_PORT || '3000');
  const host = process.env.BL_SERVER_HOST || '0.0.0.0';

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
  app.post('/', async (req: express.Request, res: express.Response)=>{
    const inputs = req.body.inputs
    // My agentic logic here, inputs will be a string
    res.send("A string output")
  })
```


```bash
bl deploy
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.