import type { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import { handleDynamicImportError } from "../common/errors";

export async function langchain(instrumentor: any) {
  try {
    const RunnableModule = await import("@langchain/core/runnables");
    const ToolsModule = await import("@langchain/core/tools");
    const VectorStoresModule = await import("@langchain/core/vectorstores");
    const langchain = instrumentor as LangChainInstrumentation;
    const AgentsModule = await import("langchain/agents");
    const ChainsModule = await import("langchain/chains");
    langchain.manuallyInstrument({
      runnablesModule: RunnableModule,
      toolsModule: ToolsModule,
      chainsModule: ChainsModule,
      agentsModule: AgentsModule,
      vectorStoreModule: VectorStoresModule,
    });
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
}
