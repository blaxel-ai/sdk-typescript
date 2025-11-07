import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { WebSocketClient } from "../websocket/index.js";
import { ApplyEditResponse, RerankingResponse } from "../client/types.gen.js";

export class SandboxCodegenWebSocket extends SandboxAction {
  private wsClient: WebSocketClient;

  constructor(sandbox: Sandbox, wsClient: WebSocketClient) {
    super(sandbox);
    this.wsClient = wsClient;
  }

  async fastapply(path: string, codeEdit: string, model?: string): Promise<ApplyEditResponse> {
    const data = await this.wsClient.send<ApplyEditResponse>("codegen:fastapply", {
      path,
      codeEdit,
      model,
    });
    return data;
  }

  async reranking(
    path: string,
    query: string,
    scoreThreshold?: number,
    tokenLimit?: number,
    filePattern?: string
  ): Promise<RerankingResponse> {
    const data = await this.wsClient.send<RerankingResponse>("codegen:reranking", {
      path,
      query,
      scoreThreshold,
      tokenLimit,
      filePattern,
    });
    return data;
  }
}

