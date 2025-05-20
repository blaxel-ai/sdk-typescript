import { SandboxInstance } from "@blaxel/core"

export async function createOrGetSandbox(sandboxName: string, wait: boolean = true) {
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
      }
    }
  }
  const sandbox = await SandboxInstance.createIfNotExists(sandboxModel)
  if (wait) {
    await sandbox.wait({ maxWait: 120000, interval: 1000 })
  }
  return sandbox
}