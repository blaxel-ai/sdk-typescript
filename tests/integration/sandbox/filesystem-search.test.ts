import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from "./helpers.js"

describe("Sandbox filesystem search", () => {
  const sandboxName = uniqueName("fs-search")
  const directory = "/tmp/search-fixtures"
  const quartzName = "quartz-report.txt"
  const nebulaName = "nebula-report.txt"
  let sandbox: SandboxInstance

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      memory: 2048,
      ttl: "1h",
      labels: defaultLabels,
    })
    await sandbox.fs.mkdir(directory)
    await Promise.all([
      sandbox.fs.write(`${directory}/${quartzName}`, "first fixture"),
      sandbox.fs.write(`${directory}/${nebulaName}`, "second fixture"),
    ])
  }, 45000)

  afterAll(async () => {
    // Delete by the reserved name even if creation timed out after provisioning.
    await SandboxInstance.delete(sandboxName)
    expect(await waitForSandboxDeletion(sandboxName, 10)).toBe(true)
  }, 15000)

  it("uses the supplied query to select different filenames", async () => {
    const [quartz, nebula] = await Promise.all([
      sandbox.fs.search("quartz", directory),
      sandbox.fs.search("nebula", directory),
    ])

    expect(quartz.matches.map(match => match.path)).toEqual([quartzName])
    expect(nebula.matches.map(match => match.path)).toEqual([nebulaName])
  }, 15000)

  it("returns no matches for a query absent from a populated directory", async () => {
    const result = await sandbox.fs.search("zzzzzzzzzzzzzzzz", directory)

    expect(result.matches).toEqual([])
    expect(result.total).toBe(0)
  }, 15000)

  it("preserves maxResults when sending the query", async () => {
    const [all, limited] = await Promise.all([
      sandbox.fs.search("report", directory),
      sandbox.fs.search("report", directory, { maxResults: 1 }),
    ])

    expect(all.matches.map(match => match.path).sort()).toEqual([nebulaName, quartzName])
    expect(limited.matches).toHaveLength(1)
    expect([quartzName, nebulaName]).toContain(limited.matches[0].path)
  }, 15000)
})
