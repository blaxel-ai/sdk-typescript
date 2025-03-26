import { Function, FunctionSpec } from "../client/index.js"
import { logger } from "../common/logger.js"
import settings from "../common/settings.js"
import { SpanManager } from "../instrumentation/span.js"
import { Tool } from "./types.js"
import { schemaToZodSchema } from "./zodSchema.js"

export class HttpTool {
  private spec: FunctionSpec
  private name: string
  constructor(name: string, spec: FunctionSpec) {
    this.name = name
    this.spec = spec
  }

  get externalUrl() {
    return new URL(`${settings.runUrl}/${settings.workspace}/functions/${this.name}`)
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl
    }
    return null
  }

  get url() {
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    if (process.env[`BL_FUNCTION_${envVar}_SERVICE_NAME`]) {
      return new URL(`https://${process.env[`BL_FUNCTION_${envVar}_SERVICE_NAME`]}.${settings.runInternalHostname}`);
    }
    return this.externalUrl
  }

  async listTools(): Promise<Tool[]> {
    return [{
      name: this.name,
      description: this.spec.description||'',
      inputSchema: schemaToZodSchema(this.spec.schema||{}),
      call: this.call.bind(this)
    }]
  }


  async call(args: any) : Promise<any> {
    logger.debug("TOOLCALLING: http", this.name, args)
    const spanManager = new SpanManager('blaxel-tracer')
    return spanManager.createActiveSpan(this.name,{
      "tool.name": this.name,
      "tool.args": JSON.stringify(args)
    }, async () => {
      try {
        return this.exec(this.url, args)
      } catch (err: any) {
        logger.error(err.stack)
        if (!this.fallbackUrl) {
          throw err
        }
      }
      return this.exec(this.fallbackUrl, args)
    })
  }

  async exec(url: URL, args: any) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...settings.headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args),
    })
    return await response.text()
  }
}

export const getHttpTool = async (functionData: Function): Promise<Tool[]> => {
  if(!functionData.spec) {
    throw new Error("Function spec is required")
  }
  const httpTool = new HttpTool(functionData.metadata?.name || "", functionData.spec)
  return await httpTool.listTools()
}