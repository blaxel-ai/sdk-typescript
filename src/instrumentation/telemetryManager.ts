/* eslint-disable no-console */
import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
} from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  Instrumentation,
  registerInstrumentations,
} from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
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
} from "@opentelemetry/sdk-trace-node";
import { logger } from "../common/logger.js";
import {
  InstrumentationInfo,
  instrumentationMap,
} from "./instrumentationMap.js";
import { DefaultAttributesSpanProcessor } from "./span.js";

export type TelemetryOptions = {
  workspace: string | null;
  name: string | null;
  authorization: string | null;
  type: string | null;
};

class TelemetryManager {
  private nodeTracerProvider: NodeTracerProvider | null;
  private meterProvider: MeterProvider | null;
  private loggerProvider: LoggerProvider | null;
  private otelLogger: Logger | null;
  private workspace: string | null;
  private authorization: string | null;
  private name: string | null;
  private type: string | null;
  private initialized: boolean;
  private configured: boolean;
  private instrumentations: Instrumentation[];
  constructor() {
    this.nodeTracerProvider = null;
    this.meterProvider = null;
    this.loggerProvider = null;
    this.otelLogger = null;
    this.workspace = null;
    this.authorization = null;
    this.name = null;
    this.type = null;
    this.initialized = false;
    this.configured = false;
    this.instrumentations = [];
  }

  initialize(options: TelemetryOptions) {
    const start = new Date();
    this.workspace = options.workspace;
    this.name = options.name;
    this.type = options.type + "s";
    if (process.env.BL_DEBUG_TELEMETRY === "true") {
      diag.setLogger(new DiagConsoleLogger(), { logLevel: DiagLogLevel.DEBUG });
    }
    if (!this.enabled || this.initialized) {
      return;
    }
    this.instrumentApp();
    this.setupSignalHandler();
    this.initialized = true;
    console.debug(
      `Telemetry initialized in ${new Date().getTime() - start.getTime()}ms`
    );
  }

  async setConfiguration(options: TelemetryOptions) {
    if (!this.enabled || this.configured) {
      return;
    }
    this.authorization = options.authorization;
    await this.setExporters();
    this.otelLogger = logs.getLogger("blaxel");
    console.debug("Telemetry ready");
    this.configured = true;
  }

  get enabled() {
    return process.env.BL_ENABLE_OPENTELEMETRY === "true";
  }

  get authHeaders() {
    const headers: Record<string, string> = {};
    if (this.authorization) {
      headers["x-blaxel-authorization"] = this.authorization;
    }
    if (this.workspace) {
      headers["x-blaxel-workspace"] = this.workspace;
    }
    return headers;
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getLogger(): Promise<Logger> {
    if (!this.otelLogger) {
      await this.sleep(100);
      return this.getLogger();
    }
    return this.otelLogger;
  }

  setupSignalHandler() {
    const signals = ["SIGINT", "SIGTERM", "uncaughtException"];
    for (const signal of signals) {
      process.on(signal, (error: Error) => {
        logger.error(error.stack);
        console.debug(`${signal} received`);
        this.shutdownApp().catch((error) => {
          console.debug("Fatal error during shutdown:", error);
          process.exit(0);
        });
      });
    }
  }

  /**
   * Get resource attributes for OpenTelemetry.
   */
  async getResourceAttributes() {
    const resource = await envDetector.detect();
    const attributes = resource.attributes;
    if (this.name) {
      attributes["service.name"] = this.name;
      attributes["workload.id"] = this.name;
    }
    if (this.workspace) {
      attributes["workspace"] = this.workspace;
    }
    if (this.type) {
      attributes["workload.type"] = this.type;
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
    return new OTLPLogExporter({
      headers: this.authHeaders,
    });
  }

  instrumentApp() {
    const pinoInstrumentation = new PinoInstrumentation();
    const httpInstrumentation = new HttpInstrumentation({
      requireParentforOutgoingSpans: true,
    });

    this.instrumentations = this.loadInstrumentation();
    this.instrumentations.push(httpInstrumentation);
    this.instrumentations.push(pinoInstrumentation);
    registerInstrumentations({
      instrumentations: this.instrumentations,
    });
  }

  async setExporters() {
    const resource = new Resource(await this.getResourceAttributes());
    const logExporter = this.getLogExporter();
    this.loggerProvider = new LoggerProvider({
      resource,
    });
    this.loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter)
    );
    logs.setGlobalLoggerProvider(this.loggerProvider);
    const traceExporter = this.getTraceExporter();
    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new DefaultAttributesSpanProcessor({
          "workload.id": this.name || "",
          "workload.type": this.type || "",
          workspace: this.workspace || "",
        }),
        new BatchSpanProcessor(traceExporter),
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
  }

  shouldInstrument(name: string, info: InstrumentationInfo): boolean {
    if (
      info.ignoreIfPackages &&
      info.ignoreIfPackages.some((pkg) => this.isPackageInstalled(pkg))
    ) {
      return false;
    }
    if (info.requiredPackages.some((pkg) => this.isPackageInstalled(pkg))) {
      return true;
    }
    return false;
  }

  loadInstrumentation(): Instrumentation[] {
    const instrumentations: Instrumentation[] = [];
    for (const [name, info] of Object.entries(instrumentationMap)) {
      if (this.shouldInstrument(name, info)) {
        console.debug(`Instrumenting ${name}`);
        const start = new Date();
        const module = this.importInstrumentationClass(
          info.modulePath,
          info.className
        );
        if (module) {
          try {
            // @ts-expect-error - Instrumentation class is not typed
            const instrumentor = new module() as Instrumentation;
            instrumentor.enable();
            instrumentations.push(instrumentor);
            if (info.init) {
              info.init(instrumentor);
            }
          } catch (error: unknown) {
            if (error instanceof Error) {
              console.debug(`Failed to instrument ${name}: ${error.stack}`);
            } else {
              console.debug(`Failed to instrument ${name}: ${String(error)}`);
            }
          }
        }
        console.debug(
          `Imported ${name} in ${new Date().getTime() - start.getTime()}ms`
        );
      }
    }
    return instrumentations;
  }

  isPackageInstalled(packageName: string): boolean {
    try {
      require.resolve(packageName, { paths: [process.cwd()] });
      return true;
    } catch {
      return false;
    }
  }

  importInstrumentationClass(modulePath: string, className: string): unknown {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require(modulePath) as { [key: string]: any };
      return module[className];
    } catch (e) {
      console.debug(
        `Could not import ${className} from ${modulePath}: ${String(e)}`
      );
      return null;
    }
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

export const telemetryManager = new TelemetryManager();
