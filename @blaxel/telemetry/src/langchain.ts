// /* eslint-disable @typescript-eslint/no-require-imports */
// import type { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
// import { handleDynamicImportError } from "../common/errors";

// export function langchain(instrumentor: any) {
//   try {
//     const RunnableModule = require("@langchain/core/runnables") as unknown;
//     const ToolsModule = require("@langchain/core/tools") as unknown;

//     const VectorStoresModule =
//       require("@langchain/core/vectorstores") as unknown;
//     const langchain = instrumentor as LangChainInstrumentation;
//     const AgentsModule = require("langchain/agents") as unknown;
//     const ChainsModule = require("langchain/chains") as unknown;
//     langchain.manuallyInstrument({
//       runnablesModule: RunnableModule,
//       toolsModule: ToolsModule,
//       chainsModule: ChainsModule,
//       agentsModule: AgentsModule,
//       vectorStoreModule: VectorStoresModule,
//     });
//   } catch (err) {
//     handleDynamicImportError(err);
//     throw err;
//   }
// }
