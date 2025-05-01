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

  static async create(sandbox: SandboxModel) {
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