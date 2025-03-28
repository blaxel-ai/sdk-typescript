 
import RunnableModule from "@langchain/core/runnables";
import ToolsModule from "@langchain/core/tools";
import VectorStoresModule from "@langchain/core/vectorstores";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import AgentsModule from "langchain/agents";
import ChainsModule from "langchain/chains";

export function langchain(instrumentor: any) {
  const langchain = instrumentor as LangChainInstrumentation;
  langchain.manuallyInstrument({
    runnablesModule: RunnableModule,
    toolsModule: ToolsModule,
    chainsModule: ChainsModule,
    agentsModule: AgentsModule,
    vectorStoreModule: VectorStoresModule,
  });
}