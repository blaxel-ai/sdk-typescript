import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeployed } from './helpers.js'

describe('SandboxInstance.updateEnvs', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(createdSandboxes.map((name) => SandboxInstance.delete(name).catch(() => undefined)))
  })

  async function echo(name: string, vars: string[]) {
    const sandbox = await SandboxInstance.get(name)
    const result = await sandbox.process.exec({
      command: vars.map((v) => `echo "${v}=\${${v}:-unset}";`).join(" "),
      waitForCompletion: true,
    })
    return result.logs ?? ""
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
    expect(await waitForSandboxDeployed(name)).toBe(true)
    const logs = await echo(name, ["KEEP", "CHANGE", "DROP", "ADDED"])
    expect(logs).toContain("KEEP=kept")
    expect(logs).toContain("CHANGE=after")
    expect(logs).toContain("DROP=unset")
    expect(logs).toContain("ADDED=new")

    const replaced = await SandboxInstance.updateEnvs(name, { ONLY: "one" }, { replace: true })
    expect(replaced.spec.runtime?.envs?.map((e) => e.name)).toEqual(["ONLY"])
    expect(await waitForSandboxDeployed(name)).toBe(true)
    const replacedLogs = await echo(name, ["ONLY", "KEEP"])
    expect(replacedLogs).toContain("ONLY=one")
    expect(replacedLogs).toContain("KEEP=unset")
  })
})
