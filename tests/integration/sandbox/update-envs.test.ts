import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeployed } from './helpers.js'

describe('SandboxInstance.updateEnvs', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(createdSandboxes.map((name) => SandboxInstance.delete(name).catch(() => undefined)))
  })

  // Read `expected`'s variables in a new process until they all match. The
  // status can still read DEPLOYED from before the update when the polling
  // starts, so the values themselves are what is waited for.
  async function echo(name: string, expected: Record<string, string>) {
    const command = Object.keys(expected).map((v) => `echo "${v}=\${${v}:-unset}";`).join(" ")
    const lines = Object.entries(expected).map(([v, value]) => `${v}=${value}`)
    let logs = ""
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await waitForSandboxDeployed(name)) {
        const sandbox = await SandboxInstance.get(name)
        const result = await sandbox.process.exec({ command, waitForCompletion: true })
        logs = result.logs ?? ""
        if (lines.every((line) => logs.split("\n").includes(line))) return logs
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return logs
  }

  it('merges, removes and replaces variables', { timeout: 60_000 }, async () => {
    const name = uniqueName("update-envs")
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
      envs: [
        { name: "KEEP", value: "kept" },
        { name: "CHANGE", value: "before" },
        { name: "DROP", value: "dropped" },
      ],
    })
    createdSandboxes.push(name)

    const updated = await SandboxInstance.updateEnvs(name, { CHANGE: "after", DROP: null, ADDED: "new" })
    // The API masks values in its responses, so only names can be checked here.
    expect(updated.spec.runtime?.envs?.map((e) => e.name)).toEqual(["KEEP", "CHANGE", "ADDED"])

    // The new environment reaches the sandbox a few seconds after the update.
    const expected = { KEEP: "kept", CHANGE: "after", DROP: "unset", ADDED: "new" }
    const logs = await echo(name, expected)
    for (const [v, value] of Object.entries(expected)) expect(logs).toContain(`${v}=${value}`)

    const replaced = await SandboxInstance.updateEnvs(name, { ONLY: "one" }, { replace: true })
    expect(replaced.spec.runtime?.envs?.map((e) => e.name)).toEqual(["ONLY"])
    const replacedLogs = await echo(name, { ONLY: "one", KEEP: "unset" })
    expect(replacedLogs).toContain("ONLY=one")
    expect(replacedLogs).toContain("KEEP=unset")
  })

  it('keeps the secret flag of the list form', { timeout: 60_000 }, async () => {
    const name = uniqueName("update-envs-secret")
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
      envs: [{ name: "PLAIN", value: "plain" }],
    })
    createdSandboxes.push(name)

    const updated = await SandboxInstance.updateEnvs(name, [{ name: "API_KEY", value: "s3cr3t-value", secret: true }])
    const envs = updated.spec.runtime?.envs ?? []
    expect(envs.find((e) => e.name === "API_KEY")?.secret).toBe(true)
    expect(envs.map((e) => e.name)).toContain("PLAIN")

    const logs = await echo(name, { API_KEY: "s3cr3t-value", PLAIN: "plain" })
    expect(logs).toContain("API_KEY=s3cr3t-value")
    expect(logs).toContain("PLAIN=plain")
  })
})
