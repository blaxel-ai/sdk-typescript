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


export async function createOrGetSandbox({sandboxName, image = "blaxel/prod-nextjs:latest", ports = [], memory = 4096, envs = []}: {sandboxName: string, image?: string, ports?: { name: string, target: number, protocol: string, envs?: { name: string, value: string }[] }[], memory?: number, envs?: { name: string, value: string }[]}) {
  // return localSandbox(sandboxName)
  if (ports.length === 0) {
    ports.push({
      name: "sandbox-api",
      target: 8080,
      protocol: "HTTP",
    })
    ports.push({
      name: "expo-web",
      target: 8081,
      protocol: "HTTP",
    })
    ports.push({
      name: "preview",
      target: 3000,
      protocol: "HTTP",
    })
  }
  const sandboxModel = {
    metadata: {
      name: sandboxName
    },
    spec: {
      runtime: {
        image,
        memory,
        ports,
        envs
      }
    }
  }
  const sandbox = await SandboxInstance.createIfNotExists(sandboxModel)
  await sandbox.wait({ maxWait: 120000, interval: 1000 })
  return sandbox
}