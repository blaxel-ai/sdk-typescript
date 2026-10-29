import { describe, expect, it } from "vitest";
import { SandboxInstance } from "./sandbox.js";
import type { Sandbox } from "../client/index.js";
import type { SandboxCreateConfiguration } from "./types.js";

// toSandboxModel is private: reach it the same way the create path does, without a network call.
const { toSandboxModel } = SandboxInstance as unknown as {
  toSandboxModel: (config: SandboxCreateConfiguration) => { model: Sandbox };
};
const toRuntime = (config: SandboxCreateConfiguration) =>
  toSandboxModel(config).model.spec?.runtime as Record<string, unknown>;

describe("SandboxInstance.create dockerConfig", () => {
  const auths = { auths: { "ghcr.io": { auth: "dXNlcjp0b2tlbg==" } } };

  it("sends an object as a JSON string in spec.runtime.dockerConfig", () => {
    const runtime = toRuntime({ image: "ghcr.io/org/private:v1", dockerConfig: auths, region: "us-pdx-1" });
    expect(runtime.image).toBe("ghcr.io/org/private:v1");
    expect(JSON.parse(runtime.dockerConfig as string)).toEqual(auths);
  });

  it("passes a string through unchanged", () => {
    const raw = JSON.stringify(auths);
    expect(toRuntime({ dockerConfig: raw, region: "us-pdx-1" }).dockerConfig).toBe(raw);
  });

  it("omits it from the request when not set", () => {
    const body: unknown = JSON.parse(JSON.stringify(toRuntime({ image: "ghcr.io/org/private:v1", region: "us-pdx-1" })));
    expect(body).not.toHaveProperty("dockerConfig");
  });
});
