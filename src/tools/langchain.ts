import { tool } from "@langchain/core/tools";
import { getTool } from "./index.js";



export async function getLangchainTool(name: string): Promise<any> {
  const blaxelTool = await getTool(name)
  return blaxelTool.map(t => tool(
    t.call,
    {
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
    })
  )
}

export async function getLangchainTools(names: string[]): Promise<any> {
  const toolArrays = await Promise.all(names.map(getLangchainTool))
  return toolArrays.flat()
}