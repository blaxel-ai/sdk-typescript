import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { LlamaIndexInstrumentation } from "@traceloop/instrumentation-llamaindex";

const llamaindex = new LlamaIndexInstrumentation();

llamaindex.enable();
registerInstrumentations({
  instrumentations: [llamaindex],
});