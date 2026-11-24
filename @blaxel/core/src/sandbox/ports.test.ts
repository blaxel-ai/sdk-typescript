import { describe, expect, it } from "vitest";
import { normalizePorts } from "./types.js";

describe("normalizePorts", () => {
  it("returns undefined for empty or missing ports", () => {
    expect(normalizePorts(undefined)).toBeUndefined();
    expect(normalizePorts([])).toBeUndefined();
  });

  it("accepts a bare port number as shorthand", () => {
    expect(normalizePorts([3000])).toEqual([{ target: 3000, protocol: "HTTP" }]);
  });

  it("accepts a numeric string as shorthand (regression: SDK-JS-5S)", () => {
    expect(normalizePorts(["3000"])).toEqual([{ target: 3000, protocol: "HTTP" }]);
  });

  it("accepts a mix of shorthands and objects", () => {
    expect(
      normalizePorts([8080, "9090", { target: 3000, protocol: "TCP" }])
    ).toEqual([
      { target: 8080, protocol: "HTTP" },
      { target: 9090, protocol: "HTTP" },
      { name: undefined, target: 3000, protocol: "TCP" },
    ]);
  });

  it("defaults protocol to HTTP for port objects", () => {
    expect(normalizePorts([{ target: 3000 }])).toEqual([
      { name: undefined, target: 3000, protocol: "HTTP" },
    ]);
  });

  it("coerces a numeric-string target inside a port object", () => {
    expect(normalizePorts([{ target: "3000" }])).toEqual([
      { name: undefined, target: 3000, protocol: "HTTP" },
    ]);
  });

  it("keeps the name of a port object", () => {
    expect(normalizePorts([{ name: "web", target: 80 }])).toEqual([
      { name: "web", target: 80, protocol: "HTTP" },
    ]);
  });

  it("rejects a non-numeric string with a clear error", () => {
    expect(() => normalizePorts(["http"])).toThrow("Invalid port target");
    expect(() => normalizePorts(["3000:8080"])).toThrow("Invalid port target");
    expect(() => normalizePorts([""])).toThrow("Invalid port target");
  });

  it("rejects out-of-range and non-integer targets", () => {
    expect(() => normalizePorts([0])).toThrow("Invalid port target");
    expect(() => normalizePorts([70000])).toThrow("Invalid port target");
    expect(() => normalizePorts([3000.5])).toThrow("Invalid port target");
  });

  it("rejects a port object without any port properties", () => {
    expect(() => normalizePorts([{ foo: "bar" }])).toThrow("Invalid port type");
  });

  it("rejects null entries", () => {
    expect(() => normalizePorts([null as unknown as number])).toThrow(
      "Invalid port type"
    );
  });
});
