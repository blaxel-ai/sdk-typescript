import { openai } from '@ai-sdk/openai';
import { blTools } from '@blaxel/vercel';
import { streamText } from 'ai';
// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request, context: { params: { id: string } }) {
  const { messages } = await req.json();
  const { id } = await context.params;

  const tools = await blTools([`sandboxes/${id}`], maxDuration * 1000)
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