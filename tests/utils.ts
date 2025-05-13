import { SandboxInstance } from "@blaxel/core"


async function localSandbox(sandboxName: string) {
  process.env[`BL_SANDBOX_${sandboxName.replace(/-/g, "_").toUpperCase()}_URL`] = "http://localhost:8080"
  const sandbox = new SandboxInstance({
    metadata: {
      name: sandboxName
    },
  })
  return sandbox
}


export async function createOrGetSandbox(sandboxName: string) {
  return localSandbox(sandboxName)
  try {
    return await SandboxInstance.get(sandboxName)
  } catch (e) {
    const sandbox = await SandboxInstance.create({
      metadata: {
        name: sandboxName
      },
      spec: {
        runtime: {
          image: "blaxel/prod-base:latest",
          memory: 2048,
          ports: [
            {
              name: "sandbox-api",
              target: 8080,
              protocol: "HTTP",
            }
          ]
        }
      }
    })
    await sandbox.wait({ maxWait: 120000, interval: 1000 })
    return sandbox
  }
}
