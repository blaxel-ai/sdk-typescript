/**
 * Manual example: inject a secret with the sandbox agent proxy, then rotate it
 * with SandboxInstance.updateNetwork.
 *
 * The sandbox calls https://httpbin.org/headers, which echoes back the request
 * headers, so we can read the value the proxy injected.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   BL_ENV=dev BL_REGION=eu-dub-1 npx tsx tests/manual/proxy_secret_update.ts
 */

import { SandboxInstance, type SandboxNetwork } from "@blaxel/core"

const ECHO_HOST = "httpbin.org"
const name = `proxy-secret-${Date.now().toString(36)}`

function network(token: string): SandboxNetwork {
  return {
    proxy: {
      routing: [
        {
          destinations: [ECHO_HOST],
          headers: { "X-Api-Key": "{{SECRET:api-key}}" },
          secrets: { "api-key": token },
        },
      ],
    },
  }
}

async function injectedKey(sandbox: SandboxInstance): Promise<string | undefined> {
  const { logs } = await sandbox.process.exec({
    command: `curl -s https://${ECHO_HOST}/headers`,
    waitForCompletion: true,
  })
  const body = JSON.parse(logs ?? "{}") as { headers?: Record<string, string> }
  return body.headers?.["X-Api-Key"]
}

async function expectKey(sandbox: SandboxInstance, expected: string) {
  // The new proxy config may take a few seconds to reach the sandbox.
  for (let i = 0; i < 15; i++) {
    const value = await injectedKey(sandbox)
    console.log(`X-Api-Key seen by ${ECHO_HOST}: ${value}`)
    if (value === expected) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`expected X-Api-Key=${expected}`)
}

const sandbox = await SandboxInstance.create({
  name,
  image: "blaxel/base-image:latest",
  network: network("secret-v1"),
})
try {
  await sandbox.process.exec({ command: "apk add --no-cache curl", waitForCompletion: true })
  await expectKey(sandbox, "secret-v1")

  await SandboxInstance.updateNetwork(name, { network: network("secret-v2") })
  await expectKey(sandbox, "secret-v2")

  console.log("OK: secret injected and rotated")
} finally {
  await SandboxInstance.delete(name)
}
