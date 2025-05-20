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


export async function createOrGetSandbox(sandboxName: string, image: string = "blaxel/prod-nextjs:latest", ports: { name: string, target: number, protocol: string }[] = []) {
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
  try {
    return await SandboxInstance.get(sandboxName)
  } catch (e) {
    const sandbox = await SandboxInstance.create({
      metadata: {
        name: sandboxName
      },
      spec: {
        runtime: {
          image,
          memory: 4096,
          ports
        }
      }
    })
    await sandbox.wait({ maxWait: 120000, interval: 1000 })
    return sandbox
  }
}
