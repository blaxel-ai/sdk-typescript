/* eslint-disable @typescript-eslint/no-require-imports */

const { tool } = require('llamaindex')
import { getTool } from "./index.js";


export const getLlamaIndexTool = async (name: string): Promise<any> => {
  const blaxelTool = await getTool(name)

  return blaxelTool.map(t => {
    return tool({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      execute: t.call,
    })
  })
}

export const getLlamaIndexTools = async (names: string[]): Promise<any> => {
  const toolArrays = await Promise.all(names.map(getLlamaIndexTool))
  return toolArrays.flat()
}

export default getLlamaIndexTools