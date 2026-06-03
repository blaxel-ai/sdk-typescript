// Regression: ENG-2680 — multipart upload-part concurrency is bounded by a
// per-domain semaphore (default 2) so concurrent large uploads cannot burst
// past the server's rapid-reset limit (NGHTTP2_ENHANCE_YOUR_CALM). This locks
// the default cap value and the semaphore's behavior (admit at the cap, FIFO
// hand-off, per-domain isolation, disable at 0). No creds, no network.
import { afterEach, describe, expect, it } from "vitest";
import { withUploadSlot } from "../../../@blaxel/core/src/common/h2fetch.js";
import { settings } from "../../../@blaxel/core/src/common/settings.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => {
  delete (settings.config as Record<string, unknown>).maxConcurrentUploadH2Requests;
});

describe("ENG-2680: multipart upload-part concurrency cap", () => {
  it("ships upload reliability on by default (concurrency cap 2, retries 3)", () => {
    expect(settings.maxConcurrentUploadH2Requests).toBe(2);
    expect(settings.fsPartRetries).toBe(3);
  });

  it("defaults to 2 concurrent upload parts per domain", async () => {
    expect(settings.maxConcurrentUploadH2Requests).toBe(2);

    let active = 0;
    let peak = 0;
    let started = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const run = (i: number) =>
      withUploadSlot("edge.test", () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        return gates[i].promise.then(() => {
          active--;
        });
      });
    const tasks = gates.map((_, i) => run(i));

    await tick();
    expect(started).toBe(2); // only 2 admitted at the cap
    expect(active).toBe(2);

    gates[0].resolve();
    await tick();
    expect(started).toBe(3); // freeing one admits the next (FIFO)

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    gates[4].resolve();
    await Promise.all(tasks);
    expect(peak).toBe(2); // never exceeded the cap
  });

  it("respects an overridden cap", async () => {
    (settings.config as Record<string, unknown>).maxConcurrentUploadH2Requests = 1;
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 3 }, () => deferred());
    const tasks = gates.map((g) =>
      withUploadSlot("edge.one", () => {
        active++;
        peak = Math.max(peak, active);
        return g.promise.then(() => {
          active--;
        });
      }),
    );
    await tick();
    expect(peak).toBe(1);
    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
  });

  it("isolates domains: a saturated domain does not block another", async () => {
    (settings.config as Record<string, unknown>).maxConcurrentUploadH2Requests = 1;
    const a = deferred();
    const aTask = withUploadSlot("edge.a", () => a.promise); // holds edge.a's only slot
    await tick();

    let bRan = false;
    await withUploadSlot("edge.b", async () => {
      bRan = true;
    });
    expect(bRan).toBe(true); // edge.b proceeds despite edge.a being full

    a.resolve();
    await aTask;
  });

  it("is unbounded when the cap is 0 (disabled)", async () => {
    (settings.config as Record<string, unknown>).maxConcurrentUploadH2Requests = 0;
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 4 }, () => deferred());
    const tasks = gates.map((g) =>
      withUploadSlot("edge.zero", () => {
        active++;
        peak = Math.max(peak, active);
        return g.promise.then(() => {
          active--;
        });
      }),
    );
    await tick();
    expect(peak).toBe(4); // no cap
    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
  });
});
