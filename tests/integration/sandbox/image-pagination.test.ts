import { ImageInstance } from "@blaxel/core"
import { describe, expect, it } from "vitest"

// Read-only checks against the configured workspace. Cursor checks require
// existing repositories/tags; do not create expensive image builds as fixtures.
describe("Image catalog pagination", () => {
  it("lists summaries and continues repository cursors", async (context) => {
    const page = await ImageInstance.list({ limit: 1, sort: "name:asc" })
    expect(page.data.length).toBeLessThanOrEqual(1)
    for (const image of page.data) {
      expect(image.metadata.name).toBeTruthy()
      expect(image.spec).not.toHaveProperty("tags")
      expect(typeof image.spec.tagCount).toBe("number")
    }
    if (!page.nextCursor) context.skip()
    const next = await page.nextPage()
    expect(next).not.toBeNull()
    expect(next!.data.length).toBeLessThanOrEqual(1)
    if (next!.data.length) {
      expect(next!.data[0].metadata).not.toEqual(page.data[0]?.metadata)
    }
  })

  it("continues tags for an existing repository", async (context) => {
    // One bounded lookup; shared repositories retain their source workspace.
    const repositories = await ImageInstance.list({ limit: 100, sort: "name:asc" })
    const image = repositories.data.find((item) => (item.spec.tagCount ?? 0) >= 2)
    if (!image) context.skip()
    const { name, resourceType, sourceWorkspace } = image!.metadata
    expect(name).toBeTruthy()
    expect(resourceType).toBeTruthy()
    const page = await ImageInstance.listTags(resourceType!, name!, {
      limit: 1, sort: "name:asc", sourceWorkspace,
    })
    expect(page.data).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
    const next = await page.nextPage()
    expect(next).not.toBeNull()
    expect(next!.data).toHaveLength(1)
    expect(next!.data[0].name).not.toBe(page.data[0].name)
  })
})
