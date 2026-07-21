export type PaginatedListMeta = {
  hasMore?: boolean;
  nextCursor?: string;
  total?: number;
};

export type CursorPaginationQuery = {
  cursor?: string;
};

export type ListResponse<T> =
  | T[]
  | {
    data?: T[] | null;
    meta?: PaginatedListMeta | null;
  }
  | null
  | undefined;

export type AutoPagingEachCallback<T> = (
  item: T,
) => boolean | void | Promise<boolean | void>;

export type AutoPagingToArrayOptions = {
  limit: number;
};

export type PaginatedList<T, TQuery extends CursorPaginationQuery = CursorPaginationQuery> = AsyncIterable<T> & {
  data: T[];
  meta: PaginatedListMeta;
  hasMore: boolean;
  nextCursor?: string;
  nextPage(): Promise<PaginatedList<T, TQuery> | null>;
  autoPagingEach(onItem: AutoPagingEachCallback<T>): Promise<void>;
  autoPagingToArray(options: AutoPagingToArrayOptions): Promise<T[]>;
};

type CreatePaginatedListOptions<TRaw, TItem, TQuery extends CursorPaginationQuery> = {
  response: ListResponse<TRaw>;
  fetchPage: (query?: TQuery) => Promise<ListResponse<TRaw>>;
  mapItem: (item: TRaw) => TItem | Promise<TItem>;
  query?: TQuery;
  seenCursors?: Set<string>;
};

export function unwrapListData<T>(response: ListResponse<T>): T[] {
  if (!response) {
    return [];
  }
  if (Array.isArray(response)) {
    return response;
  }
  return response.data ?? [];
}

function unwrapListMeta<T>(response: ListResponse<T>): PaginatedListMeta {
  if (!response || Array.isArray(response)) {
    return { hasMore: false };
  }
  return response.meta ?? { hasMore: false };
}

export async function createPaginatedList<TRaw, TItem, TQuery extends CursorPaginationQuery = CursorPaginationQuery>({
  response,
  fetchPage,
  mapItem,
  query,
  seenCursors,
}: CreatePaginatedListOptions<TRaw, TItem, TQuery>): Promise<PaginatedList<TItem, TQuery>> {
  const meta = unwrapListMeta(response);
  const data = await Promise.all(unwrapListData(response).map(mapItem));
  const cursors = new Set(seenCursors);
  if (query?.cursor) {
    cursors.add(query.cursor);
  }

  const list: PaginatedList<TItem, TQuery> = {
    data,
    meta,
    // Derive `hasMore` from cursor presence, not `meta.hasMore`: `nextPage()`
    // can only advance when there is a `nextCursor`, so a consumer doing
    // `if (page.hasMore) await page.nextPage()` must never see `hasMore: true`
    // while `nextPage()` returns null. Keeping the two in sync prevents silent
    // truncation if the API ever sends `hasMore: true` without a cursor.
    get hasMore() {
      return Boolean(list.nextCursor);
    },
    get nextCursor() {
      return meta.nextCursor || undefined;
    },
    async nextPage() {
      const cursor = list.nextCursor;
      if (!cursor) {
        return null;
      }
      if (cursors.has(cursor)) {
        throw new Error("Pagination returned a repeated cursor");
      }
      const nextQuery = { ...(query ?? {}), cursor } as TQuery;
      const nextSeenCursors = new Set(cursors);
      nextSeenCursors.add(cursor);
      return createPaginatedList({
        response: await fetchPage(nextQuery),
        fetchPage,
        mapItem,
        query: nextQuery,
        seenCursors: nextSeenCursors,
      });
    },
    async autoPagingEach(onItem) {
      for await (const item of list) {
        const shouldContinue = await onItem(item);
        if (shouldContinue === false) {
          return;
        }
      }
    },
    async autoPagingToArray(options) {
      if (!options || !Number.isFinite(options.limit) || options.limit <= 0) {
        throw new Error("autoPagingToArray requires a positive limit");
      }

      const items: TItem[] = [];
      for await (const item of list) {
        items.push(item);
        if (items.length >= options.limit) {
          return items;
        }
      }
      return items;
    },
    async *[Symbol.asyncIterator]() {
      let page: PaginatedList<TItem, TQuery> | null = list;
      while (page) {
        for (const item of page.data) {
          yield item;
        }
        page = await page.nextPage();
      }
    },
  };

  return list;
}
