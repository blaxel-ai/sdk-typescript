/* eslint-disable no-console */
import { authenticate, env, logger, settings } from "@blaxel/core";
import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  Span,
} from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  registerInstrumentations
} from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { envDetector, Resource } from "@opentelemetry/resources";
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

export class BlaxelDefaultAttributesSpanProcessor implements SpanProcessor {
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


class HasBeenProcessedSpanProcessor extends BatchSpanProcessor {
  onEnd(span: ReadableSpan) {
    super.onEnd(span);
  }
}

class BlaxelTelemetry {
  private nodeTracerProvider: NodeTracerProvider | null;
  private meterProvider: MeterProvider | null;
  private loggerProvider: LoggerProvider | null;
  private otelLogger: Logger | null;
  private configured: boolean;
  constructor() {
    this.nodeTracerProvider = null;
    this.meterProvider = null;
    this.loggerProvider = null;
    this.otelLogger = null;
    this.configured = false;
  }

  get enabled() {
    return env.BL_ENABLE_OPENTELEMETRY === "true";
  }

  get authHeaders() {
    const headers: Record<string, string> = {};
    if (settings.credentials.authorization) {
      headers["x-blaxel-authorization"] = settings.credentials.authorization;
    }
    if (settings.workspace) {
      headers["x-blaxel-workspace"] = settings.workspace;
    }
    return headers;
  }

  /**
   * Get resource attributes for OpenTelemetry.
   */
  async getResourceAttributes() {
    const resource = await envDetector.detect();
    const attributes = resource?.attributes || {};
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
    return attributes;
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
    console.log('getLogExporter', this.authHeaders)
    return new OTLPLogExporter({
      headers: this.authHeaders,
    });
  }

  /**
   * Initialize and return the Blaxel Log instance.
   */
  async getLogger(): Promise<Logger> {
    if (!this.otelLogger) {
      await this.sleep(100);
      return this.getLogger();
    }
    return this.otelLogger;
  }

  get debug() {
    return env.BL_DEBUG_TELEMETRY === "true";
  }

  // Synchronous initialization
  init() {
    if (!this.enabled || this.configured) {
      return;
    }
    if (this.debug) {
      diag.setLogger(new DiagConsoleLogger(), { logLevel: DiagLogLevel.DEBUG });
    }
    console.debug('Start Blaxel Telemetry')
    this.setupSignalHandler();

    const httpInstrumentation = new HttpInstrumentation({
      requireParentforOutgoingSpans: true,
    });

    registerInstrumentations({
      instrumentations: [httpInstrumentation],
    });

    this.ainit().catch(console.error);
  }

  // Asynchronous initialization
  async ainit() {
    await authenticate();
    const resource = await this.getResourceAttributes() as unknown as Resource;

    const logExporter = this.getLogExporter();
    this.loggerProvider = new LoggerProvider({
      resource,
    });
    this.loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter, {
        maxQueueSize: 1000,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: 5000,
      })
    );
    logs.setGlobalLoggerProvider(this.loggerProvider);
    const traceExporter = this.getTraceExporter();
    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new BlaxelDefaultAttributesSpanProcessor({
          "workload.id": settings.name || "",
          "workload.type": settings.type || "",
          workspace: settings.workspace || "",
        }),
        new BatchSpanProcessor(traceExporter),
        new HasBeenProcessedSpanProcessor(traceExporter),
      ],
    });
    this.nodeTracerProvider.register();
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
    this.otelLogger = logs.getLogger("blaxel");
    this.configured = true;
    console.debug("Telemetry ready");
  }

  /**
   * Setup a signal handler to handle shutdown events.
   */
  setupSignalHandler() {
    const signals = ["SIGINT", "SIGTERM", "uncaughtException", "exit"];
    for (const signal of signals) {
      process.on(signal, (error: Error) => {
        if (signal !== "exit") {
          logger.error(error.stack);
        }
        this.shutdownApp().catch((error) => {
          console.debug("Fatal error during shutdown:", error);
          process.exit(0);
        });
      });
    }
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the application.
   */
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
              console.debug("Error shutting down tracer provider:", error)
            )
        );
      }

      if (this.meterProvider) {
        shutdownPromises.push(
          this.meterProvider
            .shutdown()
            .catch((error) =>
              console.debug("Error shutting down meter provider:", error)
            )
        );
      }

      if (this.loggerProvider) {
        shutdownPromises.push(
          this.loggerProvider
            .shutdown()
            .catch((error) =>
              console.debug("Error shutting down logger provider:", error)
            )
        );
      }

      // Wait for all providers to shutdown with a timeout
      await Promise.race([
        Promise.all(shutdownPromises),
        new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
      ]);
      console.debug("Instrumentation shutdown complete");

      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  }

}

const blaxelTelemetry = new BlaxelTelemetry();

export default blaxelTelemetry;
