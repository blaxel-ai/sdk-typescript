import * as RunnableModule from "@langchain/core/runnables";
import * as ToolsModule from "@langchain/core/tools";
import * as AgentsModule from "@langchain/core/agents";
import * as VectorStoresModule from "@langchain/core/vectorstores";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";

const langchain = new LangChainInstrumentation();
langchain.manuallyInstrument({
  // @ts-ignore - Type definitions may be incorrect, but the method accepts these parameters at runtime
  runnablesModule: RunnableModule,
  toolsModule: ToolsModule,
  agentsModule: AgentsModule,
  vectorStoreModule: VectorStoresModule,
});

langchain.enable();
registerInstrumentations({
  instrumentations: [langchain],
});
