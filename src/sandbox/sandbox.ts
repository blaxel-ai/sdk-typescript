import { createSandbox, deleteSandbox, getSandbox, listSandboxes, Sandbox as SandboxModel } from "../client";
import { SandboxFileSystem } from "./filesystem";
import { SandboxNetwork } from "./network";
import { SandboxProcess } from "./process";

export class SandboxInstance {
  fs: SandboxFileSystem;
  network: SandboxNetwork;
  process: SandboxProcess;

  constructor(private sandbox: SandboxModel) {
    this.fs = new SandboxFileSystem(sandbox);
    this.network = new SandboxNetwork(sandbox);
    this.process = new SandboxProcess(sandbox);
  }

  get metadata() {
    return this.sandbox.metadata;
  }

  get status() {
    return this.sandbox.status;
  }

  get events() {
    return this.sandbox.events;
  }

  get spec() {
    return this.sandbox.spec;
  }

  async wait({maxWait = 60000, interval = 1000}: {maxWait?: number, interval?: number} = {}) {
    const startTime = Date.now();
    while (this.sandbox.status !== "DEPLOYED") {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        const { data } = await getSandbox({
          path: {
            sandboxName: this.sandbox.metadata?.name ?? "",
          },
          throwOnError: true,
        });
        this.sandbox = data;
      } catch(e) {
        console.error("Could not retrieve sandbox", e);
      }
      if (this.sandbox.status === "FAILED") {
        throw new Error("Sandbox failed to deploy");
      }
      if (Date.now() - startTime > maxWait) {
        throw new Error("Sandbox did not deploy in time");
      }
    }
  }

  static async create(sandbox: SandboxModel) {
    if (sandbox.spec?.runtime?.generation == undefined) {
      sandbox.spec = sandbox.spec ?? {runtime: {}}
      sandbox.spec.runtime = sandbox.spec.runtime ?? {}
      sandbox.spec.runtime.generation = "mk3"
    }
    const { data } = await createSandbox({
      body: sandbox,
      throwOnError: true,
    });
    return new SandboxInstance(data);
  }

  static async get(sandboxName: string) {
    const { data } = await getSandbox({
      path: {
        sandboxName,
      },
      throwOnError: true,
    });
    return new SandboxInstance(data);
  }

  static async list() {
    const { data } = await listSandboxes({throwOnError: true}) as { response: Response; data: SandboxModel[] };
    return data.map((sandbox) => new SandboxInstance(sandbox));
  }

  static async delete(sandboxName: string) {
    const { data } = await deleteSandbox({
      path: {
        sandboxName,
      },
      throwOnError: true,
    });
    return data;
  }
}