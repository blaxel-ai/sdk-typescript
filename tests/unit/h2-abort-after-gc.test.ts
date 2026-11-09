// ENG-6315: abort() must reach an open h2 stream even after the Request object
// is garbage collected. undici links `Request.signal` to the caller's signal
// through a WeakRef, so without a strong ref the link dies on GC and the stream
// keeps delivering data after close().
import { EventEmitter } from "events";
import type http2 from "http2";
import { setFlagsFromString } from "v8";
import { runInNewContext } from "vm";
import { expect, it } from "vitest";
import { createH2Fetch } from "../../@blaxel/core/src/common/h2fetch.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

class FakeStream extends EventEmitter {
  end(): void {}
  close(): void {}
}
class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  stream = new FakeStream();
  request(): FakeStream { return this.stream; }
  ref(): this { return this; }
  unref(): this { return this; }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

it("aborts an open h2 response stream after the Request is garbage collected", async () => {
  const session = new FakeSession();
  const controller = new AbortController();
  // Build the Request in a nested scope so nothing in this test keeps it alive.
  const pending = (() => createH2Fetch(session as unknown as http2.ClientHttp2Session)(
    new Request("https://sandbox.example/logs", { signal: controller.signal }),
  ))();
  await tick();
  session.stream.emit("response", { ":status": 200 });
  const reader = (await pending).body!.getReader();
  session.stream.emit("data", Buffer.from("1\n"));
  expect((await reader.read()).value).toBeDefined();

  for (let i = 0; i < 5; i++) { gc(); await tick(); }
  controller.abort();
  session.stream.emit("data", Buffer.from("2\n"));

  await expect(reader.read()).rejects.toThrow(/aborted/);
});
