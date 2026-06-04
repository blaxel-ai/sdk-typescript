import { describe, expect, it } from "vitest";
import { createPaginatedList, unwrapListData } from "./pagination.js";

describe("pagination helpers", () => {
  it("unwraps legacy array and paginated list responses", () => {
    expect(unwrapListData([{ name: "legacy" }])).toEqual([{ name: "legacy" }]);
    expect(unwrapListData({
      data: [{ name: "paginated" }],
      meta: { hasMore: false },
    })).toEqual([{ name: "paginated" }]);
  });

  it("returns page data and lets callers request the next page", async () => {
    const cursors: Array<string | undefined> = [];
    const fetchPage = async (query?: { cursor?: string }) => {
      await Promise.resolve();
      cursors.push(query?.cursor);
      if (!query?.cursor) {
        return {
          data: ["first"],
          meta: { hasMore: true, nextCursor: "next-page" },
        };
      }
      return {
        data: ["second"],
        meta: { hasMore: false },
      };
    };

    const page = await createPaginatedList({
      response: await fetchPage(),
      fetchPage,
      mapItem: (item) => item.toUpperCase(),
    });

    expect(page.data).toEqual(["FIRST"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("next-page");

    const nextPage = await page.nextPage();
    expect(nextPage?.data).toEqual(["SECOND"]);
    expect(cursors).toEqual([undefined, "next-page"]);
  });

  it("supports auto paging with an explicit limit", async () => {
    const fetchPage = async (query?: { cursor?: string }) => {
      await Promise.resolve();
      if (!query?.cursor) {
        return {
          data: ["first"],
          meta: { hasMore: true, nextCursor: "next-page" },
        };
      }
      return {
        data: ["second"],
        meta: { hasMore: false },
      };
    };

    const page = await createPaginatedList({
      response: await fetchPage(),
      fetchPage,
      mapItem: (item) => item,
    });

    await expect(page.autoPagingToArray({ limit: 2 })).resolves.toEqual(["first", "second"]);
  });
});
