import { createSandboxSchedule, deleteSandboxSchedule, getSandboxSchedule, listSandboxScheduleExecutions, listSandboxSchedules, updateSandboxSchedule } from "../client/index.js";
import type { Sandbox, SandboxScheduleEntry, SandboxScheduleExecution } from "../client/index.js";

/** Optional filters for listing schedules. */
export type SandboxScheduleListOptions = {
  /** Only cron and at are stored (sleep resolves to at on creation). */
  type?: "cron" | "at";
  q?: string;
  limit?: number;
  cursor?: string;
};

/** Optional filters for listing schedule executions. */
export type SandboxScheduleExecutionListOptions = {
  q?: string;
  limit?: number;
  cursor?: string;
};

// Schedule list endpoints return a bare array on older API versions and a
// cursor-paginated `{ data, meta }` envelope starting on Blaxel-Version
// 2026-04-28. Handle both so the wrapper works regardless of the SDK's default
// version.
function unwrapPage<T>(data: T[] | { data?: T[] } | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data?.data ?? [];
}

// SandboxSchedules manages a sandbox's schedules. A schedule entry is a flat
// record (id/type/value/input) with no sub-resource of its own, so methods
// return the raw SandboxScheduleEntry rather than a wrapper class (the generated
// `SandboxSchedule` type is the array form `SandboxScheduleEntry[]`).
export class SandboxSchedules {
  constructor(private sandbox: Sandbox) {}

  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  async list(options: SandboxScheduleListOptions = {}): Promise<SandboxScheduleEntry[]> {
    const { data } = await listSandboxSchedules({
      path: {
        sandboxName: this.sandboxName,
      },
      query: options,
      throwOnError: true,
    });
    return unwrapPage<SandboxScheduleEntry>(data as unknown as SandboxScheduleEntry[] | { data?: SandboxScheduleEntry[] });
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
  async executions(options: SandboxScheduleExecutionListOptions = {}): Promise<SandboxScheduleExecution[]> {
    const { data } = await listSandboxScheduleExecutions({
      path: {
        sandboxName: this.sandboxName,
      },
      query: options,
      throwOnError: true,
    });
    return unwrapPage<SandboxScheduleExecution>(data as unknown as SandboxScheduleExecution[] | { data?: SandboxScheduleExecution[] });
  }
}
