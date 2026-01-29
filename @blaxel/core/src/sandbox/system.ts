import { Sandbox } from "../client/types.gen.js";
import { SandboxAction } from "./action.js";
import { postUpgrade, PostUpgradeResponse, UpgradeRequest } from "./client/index.js";

export class SandboxSystem extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async upgrade(body?: UpgradeRequest): Promise<PostUpgradeResponse> {
    const { response, data, error } = await postUpgrade({
      baseUrl: this.url,
      client: this.client,
      body,
    });
    this.handleResponseError(response, data, error);
    return data as PostUpgradeResponse;
  }
}
