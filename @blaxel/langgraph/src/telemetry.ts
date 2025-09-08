import * as RunnableModule from "@langchain/core/runnables";
import * as ToolsModule from "@langchain/core/tools";
import * as VectorStoresModule from "@langchain/core/vectorstores";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import * as AgentsModule from "langchain/agents";
import * as ChainsModule from "langchain/chains";

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
