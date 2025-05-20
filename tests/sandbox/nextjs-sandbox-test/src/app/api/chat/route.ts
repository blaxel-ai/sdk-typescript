import { openai } from '@ai-sdk/openai';
import { SandboxInstance } from '@blaxel/core';
import { streamText, Tool } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();
  const sandbox = new SandboxInstance({});

  // Convert tools array to object format and remove execute function
  console.log(sandbox.fs.name);
  const tools = Object.entries(sandbox.fs.tools).reduce((acc, [key, value]) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { execute, ...toolWithoutExecute } = value;
    acc[key] = {
      description: toolWithoutExecute.description,
      parameters: toolWithoutExecute.parameters,
    };
    return acc;
  }, {} as Record<string, Tool>);

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are a NextJS application development expert. Your goal is to help users create complete NextJS applications based on their descriptions.
You have access to a sandbox where you already have a nextjs app running. It is located in the /blaxel/app directory.
The main page is located in the /blaxel/app/src/app/page.tsx file.
Go with the flow with what the user is asking for. No need for confirmation or other things.`,
    messages,
    tools,
  });

  return result.toDataStreamResponse();
}