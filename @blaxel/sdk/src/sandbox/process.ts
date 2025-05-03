import { Sandbox } from "../client";
import { SandboxAction } from "./action";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, postProcess } from "./client";

export class SandboxProcess extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async exec(process: ProcessRequest): Promise<PostProcessResponse> {
    const { response, data, error } = await postProcess({
      body: process,
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as PostProcessResponse;
  }

  async get(identifier: string): Promise<GetProcessByIdentifierResponse> {
    const { response, data, error } = await getProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessByIdentifierResponse;
  }

  async list(): Promise<GetProcessResponse> {
    const { response, data, error } = await getProcess({
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessResponse;
  }

  async stop(identifier: string): Promise<DeleteProcessByIdentifierResponse> {
    const { response, data, error } = await deleteProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierResponse;
  }

  async kill(identifier: string): Promise<DeleteProcessByIdentifierKillResponse> {
    const { response, data, error } = await deleteProcessByIdentifierKill({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierKillResponse;
  }

  async logs(identifier: string, type: "stdout" | "stderr" = "stdout"): Promise<string> {
    const { response, data, error } = await getProcessByIdentifierLogs({
      path: { identifier },
      baseUrl: this.url,
    });
    this.handleResponseError(response, data, error);
    if (data && type in data) {
      return data[type];
    }
    throw new Error("Unsupported log type");
  }
}

