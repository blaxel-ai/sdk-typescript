import { SandboxInstance } from "@blaxel/core"

export async function createOrGetSandbox({sandboxName }: {sandboxName: string}) {
  const envs = []
  if (process.env.MORPH_API_KEY) {
    envs.push({
      name: "MORPH_API_KEY",
      value: process.env.MORPH_API_KEY
    })
  }
  if (process.env.MORPH_MODEL) {
    envs.push({
      name: "MORPH_MODEL",
      value: process.env.MORPH_MODEL
    })
  }
  const sandboxModel = {
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
      },
      envs
    }
  }
  const sandbox = await SandboxInstance.createIfNotExists(sandboxModel)
  return sandbox
}