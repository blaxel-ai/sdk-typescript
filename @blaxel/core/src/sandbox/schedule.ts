import { createSandboxSchedule, deleteSandboxSchedule, getSandboxSchedule, listSandboxScheduleExecutions, listSandboxSchedules, updateSandboxSchedule } from "../client/index.js";
import type { ListSandboxScheduleExecutionsData, ListSandboxSchedulesData, Sandbox, SandboxScheduleEntry, SandboxScheduleExecution } from "../client/index.js";
import { createPaginatedList, type ListResponse } from "../common/pagination.js";

// Derive option types from the generated query shapes so they stay in sync with
// the API (new sort values, filters, etc.) without re-typing the literals here.
/** Optional filters for listing schedules (`type`, `q`, `limit`, `cursor`, `sort`). */
export type SandboxScheduleListOptions = NonNullable<ListSandboxSchedulesData["query"]>;

/** Optional filters for listing schedule executions (`q`, `limit`, `cursor`, `sort`). */
export type SandboxScheduleExecutionListOptions = NonNullable<ListSandboxScheduleExecutionsData["query"]>;

// SandboxSchedules manages a sandbox's schedules. A schedule entry is a flat
// record (id/type/value/input) with no sub-resource of its own, so methods
// return the raw SandboxScheduleEntry rather than a wrapper class (the generated
// `SandboxSchedule` type is the array form `SandboxScheduleEntry[]`).
export class SandboxSchedules {
  constructor(private sandbox: Sandbox) {}

  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  /**
   * List one page of the sandbox's schedules.
   *
   * The returned page exposes `data` for the current page, `meta` for cursor
   * metadata, and `nextPage()` / `autoPagingEach()` / `autoPagingToArray()`
   * helpers. Iterate it directly with `for await` to walk every page.
   *
   * @example
   * ```ts
   * const page = await sandbox.schedules.list({ limit: 50 });
   * for await (const schedule of page) {
   *   console.log(schedule.id);
   * }
   * ```
   */
  async list(options: SandboxScheduleListOptions = {}) {
    const fetchPage = async (query?: SandboxScheduleListOptions) => {
      const { data } = await listSandboxSchedules({
        path: {
          sandboxName: this.sandboxName,
        },
        query,
        throwOnError: true,
      });
      return data as unknown as ListResponse<SandboxScheduleEntry>;
    };
    return createPaginatedList({
      response: await fetchPage(options),
      fetchPage,
      mapItem: (entry: SandboxScheduleEntry) => entry,
      query: options,
    });
  }

  async create(schedule: SandboxScheduleEntry): Promise<SandboxScheduleEntry> {
    const { data } = await createSandboxSchedule({
      path: {
        sandboxName: this.sandboxName,
      },
      body: schedule,
      throwOnError: true,
    });
    return data;
  }

  async get(scheduleId: string): Promise<SandboxScheduleEntry> {
    const { data } = await getSandboxSchedule({
      path: {
        sandboxName: this.sandboxName,
        scheduleId,
      },
      throwOnError: true,
    });
    return data;
  }

  async update(scheduleId: string, schedule: SandboxScheduleEntry): Promise<SandboxScheduleEntry> {
    const { data } = await updateSandboxSchedule({
      path: {
        sandboxName: this.sandboxName,
        scheduleId,
      },
      body: schedule,
      throwOnError: true,
    });
    return data;
  }

  async delete(scheduleId: string) {
    const { data } = await deleteSandboxSchedule({
      path: {
        sandboxName: this.sandboxName,
        scheduleId,
      },
      throwOnError: true,
    });
    return data;
  }

  // List the execution history of every schedule on the sandbox, newest first.
  // Executions are sandbox-scoped, not per-schedule; filter by `scheduleId` on
  // the returned records to isolate a single schedule's runs.
  /**
   * List one page of schedule executions, newest first.
   *
   * The returned page exposes `data`, `meta`, and `nextPage()` /
   * `autoPagingEach()` / `autoPagingToArray()` helpers. Iterate it directly
   * with `for await` to walk every page.
   */
  async executions(options: SandboxScheduleExecutionListOptions = {}) {
    const fetchPage = async (query?: SandboxScheduleExecutionListOptions) => {
      const { data } = await listSandboxScheduleExecutions({
        path: {
          sandboxName: this.sandboxName,
        },
        query,
        throwOnError: true,
      });
      return data as unknown as ListResponse<SandboxScheduleExecution>;
    };
    return createPaginatedList({
      response: await fetchPage(options),
      fetchPage,
      mapItem: (execution: SandboxScheduleExecution) => execution,
      query: options,
    });
  }
}
