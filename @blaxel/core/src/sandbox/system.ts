import { Sandbox } from "../client/types.gen.js";
import { SandboxAction } from "./action.js";
import { postUpgrade, PostUpgradeResponse, UpgradeRequest } from "./client/index.js";

/** System operations on the sandbox API. Reach it through `sandbox.system`. */
export class SandboxSystem extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Upgrade the sandbox API server running in the sandbox. Returns right
   * away and the server restarts shortly after; process state is saved first
   * so running processes are kept.
   *
   * @param body - `version`: `"latest"` (default), `"develop"`, `"main"` or a
   * release tag such as `"v1.0.0"`; `baseUrl`: where to download releases
   * from, for forks.
   * @returns A confirmation message.
   *
   * @example
   * ```typescript
   * await sandbox.system.upgrade({ version: "latest" });
   * ```
   */
  async upgrade(body?: UpgradeRequest): Promise<PostUpgradeResponse> {
    const { response, data, error } = await postUpgrade(this.withClient({
      baseUrl: this.url,
      body,
    }));
    this.handleResponseError(response, data, error);
    return data as PostUpgradeResponse;
  }
}
