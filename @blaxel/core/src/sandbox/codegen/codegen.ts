import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { getCodegenRerankingByPath, putCodegenFastapplyByPath } from "../client/sdk.gen.js";
import { ApplyEditResponse, RerankingResponse } from "../client/types.gen.js";

export class SandboxCodegen extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  async fastapply(path: string, codeEdit: string, model?: string): Promise<ApplyEditResponse> {
    const result = await putCodegenFastapplyByPath({
      path: { path },
      body: { codeEdit, model },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(result.response, result.data, result.error);
    return result.data as ApplyEditResponse;
  }

  async reranking(path: string, query: string, scoreThreshold?: number, tokenLimit?: number, filePattern?: string): Promise<RerankingResponse> {
    const result = await getCodegenRerankingByPath({
      path: { path },
      query: { query, scoreThreshold, tokenLimit, filePattern },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(result.response, result.data, result.error);
    return result.data as RerankingResponse;
  }
}
