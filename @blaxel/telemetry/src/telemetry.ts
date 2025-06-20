import {
  authenticate,
  env,
  logger,
  settings,
  telemetryRegistry,
} from "@blaxel/core";
import {
  metrics,
  Span,
  trace,
  context as otelContext,
} from "@opentelemetry/api";
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

    // Setup basic TracerProvider first - this is critical for context propagation
    this.setupBasicTracerProvider();

    // Now setup instrumentation - it can now extract traceparent headers
    this.instrumentApp();
    this.setupSignalHandler();
    this.initialized = true;

    // Add exporters later asynchronously
    this.setConfiguration().catch((error) => {
      logger.error("Error setting configuration:", error);
    });
  }

  setupBasicTracerProvider() {
    const resource = new BlaxelResource(this.resourceAttributes);

    // Create TracerProvider with complete setup including exporters
    // This ensures we don't need to recreate it later, preserving context
    const spanProcessors: SpanProcessor[] = [
      new DefaultAttributesSpanProcessor({
        "workload.id": settings.name || "",
        "workload.type": settings.type ? settings.type + "s" : "",
        workspace: settings.workspace || "",
      }),
    ];

    // Try to add exporters if authentication is available
    try {
      if (settings.authorization) {
        const traceExporter = this.getTraceExporter();
        spanProcessors.push(new BatchSpanProcessor(traceExporter));
        spanProcessors.push(new HasBeenProcessedSpanProcessor(traceExporter));
        console.log("🚀 TracerProvider created with exporters from the start");
      }
    } catch {
      console.log(
        "🚀 TracerProvider created without exporters - will be added later"
      );
    }

    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors,
    });

    // Register immediately - this enables context propagation
    this.nodeTracerProvider.register();
    console.log(
      "🚀 TracerProvider registered BEFORE instrumentation - context propagation enabled"
    );
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

  instrumentApp() {
    // Setup telemetry provider first
    telemetryRegistry.registerProvider(new OtelTelemetryProvider());

    const httpInstrumentation = new HttpInstrumentation({
      requireParentforOutgoingSpans: true, // Maintain parent-child relationships
      requestHook: (span) => {
        // Debug incoming trace headers
        console.log("=== HTTP INSTRUMENTATION REQUEST HOOK ===");

        // Check if TracerProvider is registered
        const tracer = trace.getTracer("debug");
        console.log("TracerProvider available:", !!tracer);

        // Check active context
        const activeContext = otelContext.active();
        const spanContext = trace.getSpanContext(activeContext);
        console.log(
          "Span context from active context:",
          spanContext
            ? {
                traceId: spanContext.traceId,
                spanId: spanContext.spanId,
                traceFlags: spanContext.traceFlags,
              }
            : "null"
        );

        // Check current span context after HTTP instrumentation processes headers
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          console.log("✅ Active span found in request hook:", {
            traceId: activeSpan.spanContext().traceId,
            spanId: activeSpan.spanContext().spanId,
            traceFlags: activeSpan.spanContext().traceFlags,
          });
        } else {
          console.log("❌ No active span found in request hook");
          console.log("Possible causes:");
          console.log(
            "1. TracerProvider not registered before HTTP instrumentation"
          );
          console.log("2. Traceparent header not properly extracted");
          console.log("3. Context lost across async boundaries");
        }

        console.log("Current span from hook parameter:", {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          traceFlags: span.spanContext().traceFlags,
        });

        console.log("=== END HTTP INSTRUMENTATION REQUEST HOOK ===");
      },
    });

    registerInstrumentations({
      instrumentations: [httpInstrumentation],
    });
  }

  setExporters() {
    const resource = new BlaxelResource(this.resourceAttributes);

    // Setup logging
    const logExporter = this.getLogExporter();
    this.loggerProvider = new LoggerProvider({
      resource,
    });
    this.loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter)
    );
    logs.setGlobalLoggerProvider(this.loggerProvider);

    // Check if we need to add exporters to existing TracerProvider
    if (this.nodeTracerProvider && !settings.authorization) {
      // If we didn't have authorization before but we do now, recreate with exporters
      // But only if we didn't already have them
      try {
        const traceExporter = this.getTraceExporter();

        // Unfortunately, we need to recreate the TracerProvider to add exporters
        // This is a limitation of OpenTelemetry SDK
        const newTracerProvider = new NodeTracerProvider({
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

        this.nodeTracerProvider = newTracerProvider;
        this.nodeTracerProvider.register();
        console.log("📡 TracerProvider updated with exporters");
      } catch {
        console.log("📡 Could not add exporters to TracerProvider");
      }
    } else {
      console.log(
        "📡 TracerProvider already has exporters or no changes needed"
      );
    }

    // Setup metrics
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
