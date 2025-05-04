// export type InstrumentationInfo = {
//   modulePath: string;
//   className: string;
//   requiredPackages: string[]; // At least one package is required
//   ignoreIfPackages?: string[];
//   init?: (instrumentor: any) => void;
// };

// export const instrumentationMap: Record<string, InstrumentationInfo> = {
//   express: {
//     modulePath: "@opentelemetry/instrumentation-express",
//     className: "ExpressInstrumentation",
//     requiredPackages: ["express"],
//     ignoreIfPackages: ["fastify"],
//   },
//   fastify: {
//     modulePath: "@opentelemetry/instrumentation-fastify",
//     className: "FastifyInstrumentation",
//     requiredPackages: ["fastify"],
//   },
//   anthropic: {
//     modulePath: "@traceloop/instrumentation-anthropic",
//     className: "AnthropicInstrumentation",
//     requiredPackages: ["anthropic-ai/sdk"],
//   },
//   azure: {
//     modulePath: "@traceloop/instrumentation-azure",
//     className: "AzureInstrumentation",
//     requiredPackages: ["azure/openai"],
//   },
//   bedrock: {
//     modulePath: "@traceloop/instrumentation-bedrock",
//     className: "BedrockInstrumentation",
//     requiredPackages: ["aws-sdk/client-bedrock-runtime"],
//   },
//   chromadb: {
//     modulePath: "@traceloop/instrumentation-chromadb",
//     className: "ChromaDBInstrumentation",
//     requiredPackages: ["chromadb"],
//   },
//   cohere: {
//     modulePath: "@traceloop/instrumentation-cohere",
//     className: "CohereInstrumentation",
//     requiredPackages: ["cohere-js"],
//   },
//   langchain: {
//     modulePath: "@traceloop/instrumentation-langchain",
//     className: "LangChainInstrumentation",
//     requiredPackages: [
//       "langchain",
//       "@langchain/core",
//       "@langchain/community",
//       "@langchain/langgraph",
//     ],
//     init: (instrumentor: any) => {
//       // eslint-disable-next-line @typescript-eslint/no-require-imports
//       const module = require("./langchain.js") as { [key: string]: any };
//       // eslint-disable-next-line @typescript-eslint/no-unsafe-call
//       module.langchain(instrumentor);
//     },
//   },
//   llamaindex: {
//     modulePath: "@traceloop/instrumentation-llamaindex",
//     className: "LlamaIndexInstrumentation",
//     requiredPackages: ["llamaindex"],
//   },
//   openai: {
//     modulePath: "@traceloop/instrumentation-openai",
//     className: "OpenAIInstrumentation",
//     requiredPackages: ["openai"],
//   },
//   pinecone: {
//     modulePath: "@traceloop/instrumentation-pinecone",
//     className: "PineconeInstrumentation",
//     requiredPackages: ["pinecone-database/pinecone"],
//   },
//   qdrant: {
//     modulePath: "@traceloop/instrumentation-qdrant",
//     className: "QdrantInstrumentation",
//     requiredPackages: ["qdrant/js-client-rest"],
//   },
//   vertexai: {
//     modulePath: "@traceloop/instrumentation-vertexai",
//     className: "VertexAIInstrumentation",
//     requiredPackages: ["google-cloud/aiplatform"],
//   },
// };
