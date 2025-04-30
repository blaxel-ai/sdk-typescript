import { Sandbox } from "../client";
import { SandboxAction } from "./action";
import { ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, postProcess } from "./client";

export class SandboxProcess extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async exec(process: ProcessRequest) {
    const { data } = await postProcess({
      body: process,
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async get(identifier: string) {
    const { data } = await getProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async list() {
    const { data } = await getProcess({
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async stop(identifier: string) {
    const { data } = await deleteProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async kill(identifier: string) {
    const { data } = await deleteProcessByIdentifierKill({
      path: { identifier },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data;
  }

  async logs(identifier: string, type: "stdout" | "stderr" = "stdout") {
    const { data } = await getProcessByIdentifierLogs({
      path: { identifier },
      baseUrl: this.url,
      throwOnError: true,
    });
    return data[type];
  }
}

