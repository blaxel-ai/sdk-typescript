/**
 * Normalize a list endpoint response into a plain array.
 *
 * Starting with API version 2026-04-28, list endpoints return a cursor-paginated
 * wrapper of the shape `{ data?: Item[], meta?: PaginationMeta }`. Older API
 * versions return a bare array. This helper accepts either form and always
 * returns the items as an array.
 */
export function normalizeList<Item>(
  response: Item[] | { data?: Item[] } | undefined | null,
): Item[] {
  if (Array.isArray(response)) {
    return response;
  }
  return response?.data ?? [];
}
