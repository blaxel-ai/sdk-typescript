/**
 * Debounced micro-batcher for sandbox creations.
 *
 * Concurrent `SandboxInstance.create()` calls with an identical, unnamed spec
 * are merged into one `POST /sandboxes?count=N`: the first call of a group
 * arms a short timer (default 5ms) and every compatible call landing before
 * it fires joins the same request. The server answers with exactly N records
 * (or one error), so each caller resolves with its own record, in order, or
 * every caller rejects with the same error the single-create path would have
 * thrown.
 */

export const DEFAULT_CREATE_BATCH_DEBOUNCE_MS = 5;
export const MAX_CREATE_BATCH_SIZE = 100;

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type Group<T> = {
  key: string;
  pending: Pending<T>[];
  send: (count: number) => Promise<T[]>;
  timer: ReturnType<typeof setTimeout> | null;
};

export class CreateBatcher<T> {
  private groups = new Map<string, Group<T>>();

  constructor(
    private readonly debounceMs: () => number = () => DEFAULT_CREATE_BATCH_DEBOUNCE_MS,
    private readonly maxSize: number = MAX_CREATE_BATCH_SIZE,
  ) {}

  /**
   * Queue one creation under `key`. `send` is called once per flushed group
   * with the number of records to create; only the first caller's `send` is
   * used, which is fine because everything that changes the request is part
   * of the key.
   */
  enqueue(key: string, send: (count: number) => Promise<T[]>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let group = this.groups.get(key);
      if (!group) {
        group = { key, pending: [], send, timer: null };
        this.groups.set(key, group);
        group.timer = setTimeout(() => this.flush(group!), this.debounceMs());
      }
      group.pending.push({ resolve, reject });
      if (group.pending.length >= this.maxSize) {
        this.flush(group);
      }
    });
  }

  /** Number of groups currently waiting for their timer (for tests). */
  get size() {
    return this.groups.size;
  }

  private flush(group: Group<T>) {
    if (group.timer) clearTimeout(group.timer);
    if (this.groups.get(group.key) === group) {
      this.groups.delete(group.key);
    }
    const pending = group.pending;
    const count = pending.length;
    if (count === 0) return;
    group
      .send(count)
      .then((records) => {
        if (!Array.isArray(records) || records.length !== count) {
          throw new Error(
            `Bulk sandbox creation returned ${Array.isArray(records) ? records.length : "a non-array"} record(s) for a request of ${count}`,
          );
        }
        records.forEach((record, i) => pending[i].resolve(record));
      })
      .catch((err: unknown) => {
        for (const p of pending) p.reject(err);
      });
  }
}
