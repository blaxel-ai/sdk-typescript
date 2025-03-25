/* eslint-disable */
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
export function langchain(instrumentor: any) {
  const langchain = instrumentor as LangChainInstrumentation;
  const RunnableModule = require("@langchain/core/runnables");
  const ToolsModule = require("@langchain/core/tools");
  const ChainsModule = require("langchain/chains");
  const AgentsModule = require("langchain/agents");
  const VectorStoresModule = require("@langchain/core/vectorstores");
  langchain.manuallyInstrument({
    runnablesModule: RunnableModule,
    toolsModule: ToolsModule,
    chainsModule: ChainsModule,
    agentsModule: AgentsModule,
    vectorStoreModule: VectorStoresModule,
  });
}