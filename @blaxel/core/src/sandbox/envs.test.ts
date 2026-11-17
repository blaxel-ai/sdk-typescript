import { describe, expect, it } from "vitest";
import { updatedEnvs } from "./envs.js";

const current = [
  { name: "KEEP", value: "1" },
  { name: "PORT", value: "80" },
  { name: "DEBUG", value: "true" },
];

describe("updatedEnvs", () => {
  it("merges a record by name and removes null values", () => {
    expect(updatedEnvs(current, { PORT: "3000", DEBUG: null, NEW: "x" })).toEqual([
      { name: "KEEP", value: "1" },
      { name: "PORT", value: "3000" },
      { name: "NEW", value: "x" },
    ]);
  });

  it("keeps the secret flag of list entries", () => {
    expect(updatedEnvs([{ name: "API_KEY", value: "old" }], [{ name: "API_KEY", value: "k", secret: true }])).toEqual([
      { name: "API_KEY", value: "k", secret: true },
    ]);
  });

  it("replaces every variable with replace", () => {
    expect(updatedEnvs(current, { ONLY: "1" }, true)).toEqual([{ name: "ONLY", value: "1" }]);
  });

  it("handles a sandbox without envs", () => {
    expect(updatedEnvs(undefined, { A: "1" })).toEqual([{ name: "A", value: "1" }]);
  });

  it("rejects an env without a name", () => {
    expect(() => updatedEnvs(current, [{ value: "s3cr3t", secret: true }])).toThrow("without a name");
    expect(() => updatedEnvs(current, [{ value: "s3cr3t", secret: true }])).not.toThrow("s3cr3t");
  });
});
