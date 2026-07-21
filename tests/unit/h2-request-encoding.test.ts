// HTTP/2 request/response wire-encoding unit tests.
//
// The fault-injection suite proves bodies round-trip against a REAL node:http2
// server, but it only ever sends string bodies and Headers objects. The manual
// framing in `h2fetch.ts` (`h2RequestDirectInternal` / `_h2Request` / the
// response mapping in `_h2Send`) has several branches those never touch:
//   - pseudo-header derivation (:method / :path incl. query / :authority),
//   - the `host` header being dropped (it is illegal to send with :authority),
//   - the three RequestInit header shapes (Headers, array of tuples, plain obj),
//   - every body encoding branch (string, Buffer, ArrayBuffer, Uint8Array) and
//     the auto content-length (respecting an explicit one; UTF-8 byte length),
//   - response header mapping: pseudo-headers stripped, multi-value arrays
//     joined, undefined values skipped, and a missing :status defaulting to 200.
//
// These drive the transport against a capturing mock session (no socket) and
// assert the EXACT frames it would put on the wire, so a regression in the hand
// framing fails here instead of silently corrupting a real request.
import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createH2Fetch,
  h2RequestDirect,
} from "../../@blaxel/core/src/common/h2fetch.js";

type OutHeaders = http2.OutgoingHttpHeaders;

/** A stream that records the request headers and whatever body was written. */
class CapturingStream extends EventEmitter {
  public closed = false;
  public endBody: Buffer | undefined;
  end(body?: Buffer): void {
    this.endBody = body;
  }
  close(): void {
    this.closed = true;
  }
}

/** A session that records the headers passed to every `request()` call. */
class CapturingSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  public lastStream: CapturingStream | null = null;
  public lastHeaders: OutHeaders | null = null;
  request(headers: OutHeaders): CapturingStream {
    this.lastHeaders = headers;
    const stream = new CapturingStream();
    this.lastStream = stream;
    return stream;
  }
  close(): void {
    this.closed = true;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function asSession(s: CapturingSession): http2.ClientHttp2Session {
  return s as unknown as http2.ClientHttp2Session;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Drive one request through the transport, resolve it with a canned 200 (empty
 * body), and return the headers + body the transport framed on the wire.
 */
async function capture(
  fn: (session: http2.ClientHttp2Session) => Promise<Response>,
): Promise<{ headers: OutHeaders; body: Buffer | undefined; response: Response }> {
  const session = new CapturingSession();
  const promise = fn(asSession(session));
  await tick();
  const stream = session.lastStream!;
  expect(stream).not.toBeNull();
  stream.emit("response", { ":status": 200 });
  stream.emit("end");
  const response = await promise;
  return { headers: session.lastHeaders!, body: stream.endBody, response };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("h2 request framing: pseudo-headers and host handling", () => {
  it("derives :method, :path (with query), and :authority from the URL", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com:8443/a/b?x=1&y=2", {
        method: "DELETE",
      }),
    );
    expect(headers[":method"]).toBe("DELETE");
    expect(headers[":path"]).toBe("/a/b?x=1&y=2");
    expect(headers[":authority"]).toBe("edge.example.com:8443");
  });

  it("defaults the method to GET", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/only"),
    );
    expect(headers[":method"]).toBe("GET");
    expect(headers[":path"]).toBe("/only");
  });

  it("drops a caller-supplied host header (it is illegal alongside :authority)", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        headers: { Host: "spoof.example.com", "x-keep": "1" },
      }),
    );
    expect(headers.host).toBeUndefined();
    expect(headers[":authority"]).toBe("edge.example.com");
    expect(headers["x-keep"]).toBe("1");
  });
});

describe("h2 request framing: the three RequestInit header shapes", () => {
  it("accepts a plain object (keys lowercased)", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        headers: { "X-Custom": "v", Authorization: "Bearer t" },
      }),
    );
    expect(headers["x-custom"]).toBe("v");
    expect(headers["authorization"]).toBe("Bearer t");
  });

  it("accepts an array of tuples", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        headers: [
          ["X-A", "1"],
          ["host", "drop-me"],
        ],
      }),
    );
    expect(headers["x-a"]).toBe("1");
    expect(headers.host).toBeUndefined();
  });

  it("accepts a Headers instance", async () => {
    const h = new Headers();
    h.set("X-B", "2");
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", { headers: h }),
    );
    expect(headers["x-b"]).toBe("2");
  });
});

describe("h2 request framing: body encodings and content-length", () => {
  it("encodes a string body and sets content-length to its UTF-8 byte length", async () => {
    // "é" is two UTF-8 bytes, so byte length (4) != char length (3).
    const payload = "aé b";
    const { headers, body } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        method: "POST",
        body: payload,
      }),
    );
    const expected = Buffer.from(payload);
    expect(headers["content-length"]).toBe(expected.byteLength);
    expect(expected.byteLength).toBe(5);
    expect(body!.equals(expected)).toBe(true);
  });

  it("encodes a Buffer body verbatim", async () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const { headers, body } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        method: "POST",
        body: payload,
      }),
    );
    expect(headers["content-length"]).toBe(5);
    expect(body!.equals(payload)).toBe(true);
  });

  it("encodes an ArrayBuffer body", async () => {
    const ab = new Uint8Array([9, 8, 7]).buffer;
    const { headers, body } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        method: "PUT",
        body: ab,
      }),
    );
    expect(headers["content-length"]).toBe(3);
    expect(Array.from(body!)).toEqual([9, 8, 7]);
  });

  it("encodes a Uint8Array body honoring its byteOffset/byteLength (subarray view)", async () => {
    const backing = new Uint8Array([0, 0, 42, 43, 44, 0]);
    const view = backing.subarray(2, 5); // [42,43,44], nonzero byteOffset
    const { headers, body } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        method: "PUT",
        body: view,
      }),
    );
    expect(headers["content-length"]).toBe(3);
    expect(Array.from(body!)).toEqual([42, 43, 44]);
  });

  it("does not overwrite an explicit content-length", async () => {
    const { headers } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p", {
        method: "POST",
        headers: { "content-length": "999" },
        body: "abc",
      }),
    );
    expect(headers["content-length"]).toBe("999");
  });

  it("sets no content-length for a body-less request", async () => {
    const { headers, body } = await capture((s) =>
      h2RequestDirect(s, "http://edge.example.com/p"),
    );
    expect(headers["content-length"]).toBeUndefined();
    expect(body).toBeUndefined();
  });
});

describe("h2 request framing via createH2Fetch (Request objects)", () => {
  it("strips host, derives pseudo-headers, and frames the body from a Request", async () => {
    const { headers, body } = await capture((s) => {
      const h2fetch = createH2Fetch(s);
      return h2fetch(
        new Request("http://edge.example.com/r?q=z", {
          method: "POST",
          headers: { "x-req": "yes" },
          body: "hello",
        }),
      );
    });
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe("/r?q=z");
    expect(headers[":authority"]).toBe("edge.example.com");
    expect(headers.host).toBeUndefined();
    expect(headers["x-req"]).toBe("yes");
    expect(headers["content-length"]).toBe(5);
    expect(body!.toString()).toBe("hello");
  });
});

describe("h2 response mapping in _h2Send", () => {
  it("maps status, strips pseudo-headers, joins multi-value headers, and skips undefined", async () => {
    const session = new CapturingSession();
    const promise = h2RequestDirect(
      asSession(session),
      "http://edge.example.com/p",
    );
    await tick();
    const stream = session.lastStream!;
    stream.emit("response", {
      ":status": 207,
      "content-type": "application/json",
      "set-cookie": ["a=1", "b=2"], // array -> joined
      "x-absent": undefined, // skipped
    });
    stream.emit("end");

    const res = await promise;
    expect(res.status).toBe(207);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(res.headers.has("x-absent")).toBe(false);
    // Pseudo-headers never leak into the public Response headers.
    expect([...res.headers.keys()].some((k) => k.startsWith(":"))).toBe(false);
  });

  it("defaults the status to 200 when the response omits :status", async () => {
    const session = new CapturingSession();
    const promise = h2RequestDirect(
      asSession(session),
      "http://edge.example.com/p",
    );
    await tick();
    const stream = session.lastStream!;
    stream.emit("response", { "content-type": "text/plain" });
    stream.emit("data", Buffer.from("body"));
    stream.emit("end");

    const res = await promise;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("body");
  });
});
