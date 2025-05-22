import { SandboxInstance } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

async function getSandbox() {
  const sandboxName = "sandbox-jonas"
  const sandbox = await SandboxInstance.createIfNotExists({
    metadata: {
      name: sandboxName
    },
    spec: {
      runtime: {
        image: "blaxel/prod-nextjs:latest",
        memory: 4096,
        ports: [
          {
            name: "sandbox-api",
            target: 8080,
            protocol: "HTTP",
          },
          {
            name: "preview",
            target: 3000,
            protocol: "HTTP",
          }
        ]
      }
    }
  })
  await sandbox.wait()
  return sandbox
}
async function main() {
  const sandbox = await getSandbox()
  const tools = await blTools([`sandbox/${sandbox.metadata?.name}`])

  const prompt = `
  You are a NextJS application development expert. Your goal is to help users create complete NextJS applications based on their descriptions.
  You have access to a sandbox where you already have a nextjs app running. It is located in the /blaxel/app directory.
  The main page is located in the /blaxel/app/src/app/page.tsx file.
  Go with the flow with what the user is asking for. No need for confirmation or other things.
  `

  // const llm = await blModel("llama-4-scout")
  const llm = await blModel("gpt-4-1-mini-2025-04-14")
  const agent = createReactAgent({
    llm,
    prompt,
    tools,
  })

  const messages = [
    new HumanMessage("What tools do you have ? Don't hesitate to write an encyclopedia long description of the tools you have"),
  ]
  const response = await agent.stream({
    messages,
  }, { streamMode: "messages"});
  for await (const chunk of response) {
    for (const message of chunk) {
      if ("content" in message) {
        process.stdout.write(String(message.content))
      }
    }
  }
}

main()
.catch((err) => {
  console.error("There was an error => ", err);
  process.exit(1);
})
.then(() => {
  process.exit(0);
})
