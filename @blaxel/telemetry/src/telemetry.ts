import {
  authenticate,
  env,
  logger,
  settings,
  telemetryRegistry,
} from "@blaxel/core";
import { metrics, Span, trace, propagation, context } from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

import {
  envDetector,
  RawResourceAttribute,
  Resource,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OtelTelemetryProvider } from "./telemetry_provider";
export class BlaxelResource implements Resource {
  attributes: Record<string, string>;

  constructor(attributes: Record<string, string>) {
    this.attributes = attributes;
  }

  merge(other: Resource | null): Resource {
    if (other?.attributes) {
      for (const [key, value] of Object.entries(other.attributes)) {
        if (typeof value === "string") {
          this.attributes[key] = value;
        }
      }
    }
    return this;
  }

  getRawAttributes(): RawResourceAttribute[] {
    return Object.entries(this.attributes).map(([key, value]) => [key, value]);
  }
}

export class DefaultAttributesSpanProcessor implements SpanProcessor {
  constructor(private defaultAttributes: Record<string, string>) {}

  onStart(span: Span): void {
    Object.entries(this.defaultAttributes).forEach(([key, value]) => {
      span.setAttribute(key, value);
    });
  }

  onEnd(): void {}
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export type TelemetryOptions = {
  workspace: string | null;
  name: string | null;
  authorization: string | null;
  type: string | null;
};

class HasBeenProcessedSpanProcessor extends BatchSpanProcessor {
  onEnd(span: ReadableSpan) {
    super.onEnd(span);
  }
}

class TelemetryManager {
  private nodeTracerProvider: NodeTracerProvider | null;
  private meterProvider: MeterProvider | null;
  private loggerProvider: LoggerProvider | null;
  private otelLogger: Logger | null;
  private initialized: boolean;
  private configured: boolean;
  constructor() {
    this.nodeTracerProvider = null;
    this.meterProvider = null;
    this.loggerProvider = null;
    this.otelLogger = null;
    this.initialized = false;
    this.configured = false;
  }

  // This method need to stay sync to avoid non booted instrumentations
  initialize() {
    if (!this.enabled || this.initialized) {
      return;
    }
    this.instrumentAppAsync().catch((error) => {
      logger.error("Error during async instrumentation setup:", error);
    });
    this.setupSignalHandler();
    this.initialized = true;
    this.setConfiguration().catch((error) => {
      logger.error("Error setting configuration:", error);
    });
  }

  async setConfiguration() {
    if (!this.enabled || this.configured) {
      return;
    }
    await authenticate();
    this.setExporters();
    this.otelLogger = logs.getLogger("blaxel");
    logger.debug("Telemetry ready");
    this.configured = true;
  }

  get tracer() {
    return trace.getTracer("blaxel");
  }

  get enabled() {
    return env.BL_ENABLE_OPENTELEMETRY === "true";
  }

  get isLambdaEnvironment() {
    return !!(
      process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
    );
  }

  get authHeaders() {
    const headers: Record<string, string> = {};
    if (settings.authorization) {
      headers["x-blaxel-authorization"] = settings.authorization;
    }
    if (settings.workspace) {
      headers["x-blaxel-workspace"] = settings.workspace;
    }
    return headers;
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async retryContextExtraction(
    headers: Record<string, string | string[]>,
    span: Span,
    traceparentParts: string[]
  ) {
    // More aggressive retries in Lambda environment
    const maxRetries = this.isLambdaEnvironment ? 5 : 3;
    const retryDelay = this.isLambdaEnvironment ? 100 : 50; // Longer delays for Lambda cold starts

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Context extraction attempt ${attempt}/${maxRetries}`);

        // Check if propagation is ready
        const propagationFields = propagation.fields();
        logger.debug("Current propagation fields:", propagationFields);

        if (propagationFields.length === 0 && attempt < maxRetries) {
          logger.debug(
            `Propagation not ready on attempt ${attempt}, waiting ${
              retryDelay * attempt
            }ms...`
          );
          await this.sleep(retryDelay * attempt);
          continue;
        }

        // Try to extract trace context
        const extractedContext = propagation.extract(context.active(), headers);
        const extractedSpan = trace.getSpan(extractedContext);

        if (extractedSpan) {
          const extractedSpanContext = extractedSpan.spanContext();
          logger.debug(
            "Manual context extraction succeeded on attempt " + attempt + ":",
            JSON.stringify({
              traceId: extractedSpanContext.traceId,
              spanId: extractedSpanContext.spanId,
              traceFlags: extractedSpanContext.traceFlags,
            })
          );
          return; // Success!
        }

        if (attempt < maxRetries) {
          logger.debug(
            `Context extraction failed on attempt ${attempt}, retrying...`
          );
          await this.sleep(retryDelay * attempt);
        }
      } catch (error) {
        logger.debug(`Error on context extraction attempt ${attempt}:`, error);
        if (attempt < maxRetries) {
          await this.sleep(retryDelay * attempt);
        }
      }
    }

    // All retries failed - add fallback attributes
    logger.debug(
      "All context extraction attempts failed, adding fallback attributes"
    );
    if (
      traceparentParts.length === 4 &&
      traceparentParts[1] !== "00000000000000000000000000000000"
    ) {
      try {
        span.setAttributes({
          "trace.parent.trace_id": traceparentParts[1],
          "trace.parent.span_id": traceparentParts[2],
          "trace.parent.trace_flags": traceparentParts[3],
          "trace.extraction.failed": "true",
          "trace.extraction.reason": "lambda_cold_start",
        });
        logger.debug("Added fallback parent trace info as span attributes");
      } catch (error) {
        logger.debug("Error setting fallback trace attributes:", error);
      }
    }
  }

  async flush() {
    if (this.nodeTracerProvider) {
      await this.nodeTracerProvider.shutdown();
    }
    if (this.meterProvider) {
      await this.meterProvider.shutdown();
    }
    if (this.loggerProvider) {
      await this.loggerProvider.shutdown();
    }
  }

  async getLogger(): Promise<Logger> {
    if (!this.otelLogger) {
      await this.sleep(100);
      return this.getLogger();
    }
    return this.otelLogger;
  }

  setupSignalHandler() {
    const signals = ["SIGINT", "SIGTERM", "uncaughtException", "exit"];
    for (const signal of signals) {
      process.on(signal, () => {
        this.shutdownApp().catch((error) => {
          logger.debug("Fatal error during shutdown:", error);
          process.exit(0);
        });
      });
    }
  }

  /**
   * Get resource attributes for OpenTelemetry.
   */
  get resourceAttributes() {
    const resource = envDetector.detect();
    const attributes = resource.attributes || {};
    if (settings.name) {
      attributes["service.name"] = settings.name;
      attributes["workload.id"] = settings.name;
    }
    if (settings.workspace) {
      attributes["workspace"] = settings.workspace;
    }
    if (settings.type) {
      attributes["workload.type"] = settings.type + "s";
    }
    // Only keep string values
    const stringAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (typeof v === "string") stringAttrs[k] = v;
    }
    return stringAttrs;
  }

  /**
   * Initialize and return the OTLP Metric Exporter.
   */
  getMetricExporter() {
    return new OTLPMetricExporter({
      headers: this.authHeaders,
    });
  }

  /**
   * Initialize and return the OTLP Trace Exporter.
   */
  getTraceExporter() {
    return new OTLPTraceExporter({
      headers: this.authHeaders,
    });
  }

  /**
   * Initialize and return the OTLP Log Exporter.
   */
  getLogExporter() {
    return new OTLPLogExporter({
      headers: this.authHeaders,
    });
  }

  async instrumentAppAsync() {
    logger.debug(
      "Available propagation fields before setup:",
      propagation.fields()
    );

    if (this.isLambdaEnvironment) {
      logger.debug(
        "Lambda environment detected - using enhanced cold start handling"
      );
    }

    // Note: W3C propagator should be auto-registered by NodeTracerProvider
    logger.debug("Will check propagation after tracer registration...");

    telemetryRegistry.registerProvider(new OtelTelemetryProvider());

    // Set up a basic tracer provider early to enable propagation
    const earlyResource = new BlaxelResource(this.resourceAttributes);
    const earlyTracerProvider = new NodeTracerProvider({
      resource: earlyResource,
      sampler: new AlwaysOnSampler(),
    });
    earlyTracerProvider.register();

    // Small delay to ensure propagation is ready (especially important for Lambda cold starts)
    await this.sleep(10);

    logger.debug(
      "Early tracer provider registered, checking propagation:",
      propagation.fields()
    );

    const httpInstrumentation = new HttpInstrumentation({
      requireParentforOutgoingSpans: true,
      requireParentforIncomingSpans: false, // Allow root spans for incoming requests
      ignoreIncomingRequestHook: () => false, // Don't ignore any requests
      ignoreOutgoingRequestHook: () => false, // Don't ignore any requests
      requestHook: (span, request) => {
        // Log incoming headers for debugging
        if ("headers" in request && request.headers) {
          logger.debug(
            "Incoming HTTP headers:",
            JSON.stringify(request.headers)
          );
          // Specifically log trace context headers
          const headers = request.headers as Record<string, string | string[]>;
          const traceHeaders = {
            traceparent: headers.traceparent,
            tracestate: headers.tracestate,
            "x-blaxel-authorization": headers["x-blaxel-authorization"],
            "x-blaxel-workspace": headers["x-blaxel-workspace"],
          };
          logger.debug("Trace context headers:", JSON.stringify(traceHeaders));

          // Manual trace context extraction for debugging
          if (headers.traceparent) {
            try {
              const traceparentValue = Array.isArray(headers.traceparent)
                ? headers.traceparent[0]
                : headers.traceparent;
              logger.debug("Manual traceparent parsing:", traceparentValue);

              // Try to manually parse the traceparent header
              const parts = traceparentValue.split("-");
              if (parts.length === 4) {
                logger.debug(
                  "Traceparent parts:",
                  JSON.stringify({
                    version: parts[0],
                    traceId: parts[1],
                    spanId: parts[2],
                    flags: parts[3],
                  })
                );

                // Check if this looks like a valid traceparent
                if (
                  parts[1] !== "00000000000000000000000000000000" &&
                  parts[2] !== "0000000000000000"
                ) {
                  logger.debug(
                    "Traceparent appears valid - extraction should work"
                  );
                } else {
                  logger.debug("Traceparent contains invalid IDs");
                }
              }

              // Extract trace context with retry for Lambda cold starts
              void this.retryContextExtraction(headers, span, parts);
            } catch (error) {
              logger.debug("Manual context extraction error:", error);
            }
          }

          // Log the span context that was created from the incoming request
          const spanContext = span.spanContext();
          logger.debug(
            "HTTP span context:",
            JSON.stringify({
              traceId: spanContext.traceId,
              spanId: spanContext.spanId,
              traceFlags: spanContext.traceFlags,
            })
          );
        }
      },
      responseHook: (span) => {
        const spanContext = span.spanContext();
        logger.debug(
          "HTTP response span context:",
          JSON.stringify({
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            traceFlags: spanContext.traceFlags,
          })
        );
      },
    });

    registerInstrumentations({
      instrumentations: [httpInstrumentation],
    });
  }

  setExporters() {
    // Log current propagators for debugging
    logger.debug("Current propagators:", propagation.fields());

    const resource = new BlaxelResource(this.resourceAttributes);
    const logExporter = this.getLogExporter();
    this.loggerProvider = new LoggerProvider({
      resource,
    });
    this.loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter)
    );
    logs.setGlobalLoggerProvider(this.loggerProvider);
    const traceExporter = this.getTraceExporter();

    // Create a new tracer provider with full configuration
    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new DefaultAttributesSpanProcessor({
          "workload.id": settings.name || "",
          "workload.type": settings.type ? settings.type + "s" : "",
          workspace: settings.workspace || "",
        }),
        new BatchSpanProcessor(traceExporter),
        new HasBeenProcessedSpanProcessor(traceExporter),
      ],
    });

    // Replace the early tracer provider with the fully configured one
    this.nodeTracerProvider.register();

    // Ensure W3C trace context propagation is working
    logger.debug(
      "Propagation fields after tracer registration:",
      propagation.fields()
    );

    const metricExporter = this.getMetricExporter();
    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 60000,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(this.meterProvider);
  }

  async shutdownApp() {
    try {
      const maxSleepTime = 5000;
      const startTime = Date.now();
      while (!this.configured && Date.now() - startTime < maxSleepTime) {
        await this.sleep(100);
      }

      const shutdownPromises = [];
      if (this.nodeTracerProvider) {
        shutdownPromises.push(
          this.nodeTracerProvider
            .shutdown()
            .catch((error) =>
              logger.debug("Error shutting down tracer provider:", error)
            )
        );
      }

      if (this.meterProvider) {
        shutdownPromises.push(
          this.meterProvider
            .shutdown()
            .catch((error) =>
              logger.debug("Error shutting down meter provider:", error)
            )
        );
      }

      if (this.loggerProvider) {
        shutdownPromises.push(
          this.loggerProvider
            .shutdown()
            .catch((error) =>
              logger.debug("Error shutting down logger provider:", error)
            )
        );
      }

      // Wait for all providers to shutdown with a timeout
      await Promise.race([
        Promise.all(shutdownPromises),
        new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
      ]);
      logger.debug("Instrumentation shutdown complete");

      process.exit(0);
    } catch (error) {
      logger.error("Error during shutdown:", error);
      process.exit(1);
    }
  }
}

export const blaxelTelemetry = new TelemetryManager();
