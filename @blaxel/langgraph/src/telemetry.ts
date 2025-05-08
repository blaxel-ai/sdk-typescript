import RunnableModule from "@langchain/core/runnables";
import ToolsModule from "@langchain/core/tools";
import VectorStoresModule from "@langchain/core/vectorstores";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import AgentsModule from "langchain/agents";
import ChainsModule from "langchain/chains";

const langchain = new LangChainInstrumentation();
langchain.manuallyInstrument({
  runnablesModule: RunnableModule,
  toolsModule: ToolsModule,
  chainsModule: ChainsModule,
  agentsModule: AgentsModule,
  vectorStoreModule: VectorStoresModule,
});

langchain.enable();
registerInstrumentations({
  instrumentations: [langchain],
});