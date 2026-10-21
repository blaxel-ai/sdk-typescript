import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { getCodegenRerankingByPath, putCodegenFastapplyByPath } from "../client/sdk.gen.js";
import { ApplyEditResponse, RerankingResponse } from "../client/types.gen.js";

/**
 * AI code editing tools that run in the sandbox. Reach it through
 * `sandbox.codegen`. They call a model provider with a key from the sandbox's
 * environment: set `RELACE_API_KEY` (preferred) or `MORPH_API_KEY` in `envs`
 * when creating the sandbox. Without one, calls fail with HTTP 503.
 *
 * @example
 * ```typescript
 * const sandbox = await SandboxInstance.create({
 *   envs: [{ name: "RELACE_API_KEY", value: process.env.RELACE_API_KEY! }],
 * });
 * await sandbox.codegen.fastapply("/app/src/index.ts", [
 *   "// ... existing code ...",
 *   "export const port = 8080;",
 *   "// ... existing code ...",
 * ].join("\n"));
 * ```
 */
export class SandboxCodegen extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Apply a partial code edit to a file with a fast-apply model, which merges
   * the edit into the current content and writes the result. A missing file
   * is created from the edit.
   *
   * @param path - File to edit.
   * @param codeEdit - The changed code, with `// ... existing code ...`
   * standing for each unchanged span. Leaving out a span without that marker
   * may delete it.
   * @param model - Provider model. Defaults to `"auto"`.
   * @returns `success`, `originalContent`, `updatedContent` and the `provider` used.
   * @throws On HTTP 400 when the path is a directory, and 503 when no provider key is set.
   */
  async fastapply(path: string, codeEdit: string, model?: string): Promise<ApplyEditResponse> {
    const result = await putCodegenFastapplyByPath(this.withClient({
      path: { path },
      body: { codeEdit, model },
      baseUrl: this.url,
    }));
    this.handleResponseError(result.response, result.data, result.error);
    return result.data as ApplyEditResponse;
  }

  /**
   * Find the files under a directory most relevant to a natural-language
   * query, ranked by a reranking model. Needs `RELACE_API_KEY`; with only
   * `MORPH_API_KEY` it fails with HTTP 503.
   *
   * @param path - Directory to search.
   * @param query - What to look for, in natural language.
   * @param scoreThreshold - Minimum relevance score. Defaults to 0.5.
   * @param tokenLimit - Maximum tokens of file content returned. Defaults to 30000.
   * @param filePattern - Regular expression the file path or name must match, such as `".*\\.ts$"`.
   * @returns The ranked `files`.
   */
  async reranking(path: string, query: string, scoreThreshold?: number, tokenLimit?: number, filePattern?: string): Promise<RerankingResponse> {
    const result = await getCodegenRerankingByPath(this.withClient({
      path: { path },
      query: { query, scoreThreshold, tokenLimit, filePattern },
      baseUrl: this.url,
    }));
    this.handleResponseError(result.response, result.data, result.error);
    return result.data as RerankingResponse;
  }
}
