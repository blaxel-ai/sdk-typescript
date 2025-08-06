import { authenticate, env, logger, settings, telemetryRegistry } from "@blaxel/core";
import {
  metrics,
  Span,
  trace
} from "@opentelemetry/api";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { envDetector, RawResourceAttribute, Resource } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  BufferConfig,
  NodeTracerProvider,
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  AuthRefreshingMetricExporter,
  AuthRefreshingSpanExporter,
  createMetricExporter,
  createTraceExporter
} from "./auth_refresh_exporters";
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
  constructor(exporter: SpanExporter, config?: BufferConfig) {
    super(exporter, config);
  }

  onEnd(span: ReadableSpan) {
    super.onEnd(span);
  }
}

class TelemetryManager {
  private nodeTracerProvider: NodeTracerProvider | null;
  private meterProvider: MeterProvider | null;
  private initialized: boolean;
  private configured: boolean;
  constructor() {
    this.nodeTracerProvider = null;
    this.meterProvider = null;
    this.initialized = false;
    this.configured = false;
  }

  // This method need to stay sync to avoid non booted instrumentations
  initialize() {
    if (!this.enabled || this.initialized) {
      logger.debug(`[TelemetryManager] Initialize skipped - enabled: ${this.enabled}, initialized: ${this.initialized}`);
      return;
    }
    logger.debug("[TelemetryManager] Starting telemetry initialization");
    this.instrumentApp();
    this.setupSignalHandler();
    this.initialized = true;
    logger.debug("[TelemetryManager] Telemetry initialized, setting configuration async");
    this.setConfiguration().catch((error) => {
      logger.error("[TelemetryManager] Error setting configuration:", error);
    });
  }

  async setConfiguration() {
    if (!this.enabled || this.configured) {
      logger.debug(`[TelemetryManager] SetConfiguration skipped - enabled: ${this.enabled}, configured: ${this.configured}`);
      return;
    }
    logger.debug("[TelemetryManager] Starting authentication for telemetry configuration");
    await authenticate();
    logger.debug("[TelemetryManager] Authentication completed, setting up exporters");
    this.setExporters();
    logger.debug("[TelemetryManager] Telemetry configuration complete");
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
      attributes["workload.type"] = settings.type+"s";
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
    return createMetricExporter();
  }

  /**
   * Initialize and return the OTLP Trace Exporter.
   */
  getTraceExporter() {
    return createTraceExporter();
  }

  instrumentApp() {
    telemetryRegistry.registerProvider(new OtelTelemetryProvider());
    const httpInstrumentation = new HttpInstrumentation({
      requireParentforOutgoingSpans: true,
    });

    registerInstrumentations({
      instrumentations: [httpInstrumentation],
    });
  }

  setExporters() {
    const resource = new BlaxelResource(this.resourceAttributes);

    logger.debug("[TelemetryManager] Setting up exporters with authentication refresh");

    // Configure batch processor options with 1-second delay
    const batchProcessorOptions = {
      scheduledDelayMillis: 1000,  // Export every 1 second
      exportTimeoutMillis: 5000,   // Timeout for export
      maxExportBatchSize: 512,     // Max batch size
      maxQueueSize: 2048           // Max queue size
    };

    logger.debug("[TelemetryManager] Batch processor options:", batchProcessorOptions);

    // Create auth-refreshing trace exporter
    const traceExporter = new AuthRefreshingSpanExporter(() => this.getTraceExporter());
    logger.debug("[TelemetryManager] Created AuthRefreshingSpanExporter");

    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new DefaultAttributesSpanProcessor({
          "workload.id": settings.name || "",
          "workload.type": settings.type? settings.type+"s" : "",
          workspace: settings.workspace || "",
        }),
        new BatchSpanProcessor(traceExporter, batchProcessorOptions),
        new HasBeenProcessedSpanProcessor(traceExporter, batchProcessorOptions),
      ],
    });
    this.nodeTracerProvider.register();
    logger.debug("[TelemetryManager] Trace provider registered");

    // Create auth-refreshing metric exporter
    const metricExporter = new AuthRefreshingMetricExporter(() => this.getMetricExporter());
    logger.debug("[TelemetryManager] Created AuthRefreshingMetricExporter");

    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 1000,  // Changed from 60000 to 1000 (1 second)
        }),
      ],
    });
    metrics.setGlobalMeterProvider(this.meterProvider);
    logger.debug("[TelemetryManager] Metric provider configured with 1-second export interval");
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
