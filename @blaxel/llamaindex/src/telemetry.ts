import { logger } from "@blaxel/core";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";

// Safely initialize LlamaIndex telemetry instrumentation
async function initializeTelemetry() {
  try {
    const { LlamaIndexInstrumentation } = await import("@traceloop/instrumentation-llamaindex");

    const llamaindex = new LlamaIndexInstrumentation();

    // Try to enable the instrumentation
    llamaindex.enable();

    registerInstrumentations({
      instrumentations: [llamaindex],
    });

  } catch (error) {
    // Log the error but don't crash the application
    logger.warn("LlamaIndex telemetry instrumentation failed to initialize:",
      error instanceof Error ? error.message : String(error));
    logger.warn("Continuing without LlamaIndex-specific telemetry...");
  }
}

// Initialize telemetry asynchronously
initializeTelemetry().catch((error) => {
  logger.warn("Failed to initialize telemetry:", error instanceof Error ? error.message : String(error));
});
