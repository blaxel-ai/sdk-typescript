import { Sandbox } from "../client/types.gen.js";
import { SandboxAction } from "./action.js";
import { postRestart, PostRestartResponse } from "./client/index.js";

export class SandboxSystem extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async restart(): Promise<PostRestartResponse> {
    const { response, data, error } = await postRestart({
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as PostRestartResponse;
  }
}
