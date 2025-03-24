/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable no-console */
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { envDetector, Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler, BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import { instrumentationMap } from "./instrumentationMap.js";

export type TelemetryOptions = {
  workspace: string | null;
  name: string | null;
  authorization: string | null;
}

class TelemetryManager {
  private nodeTracerProvider: NodeTracerProvider | null;
  private meterProvider: MeterProvider | null  ;
  private loggerProvider: LoggerProvider | null;
  private otelLogger: Logger | null;
  private workspace: string | null;
  private authorization: string | null;
  private name: string | null;
  private initialized: boolean;

  constructor() {
    this.nodeTracerProvider = null;
    this.meterProvider = null;
    this.loggerProvider = null;
    this.otelLogger = null;
    this.workspace = null;
    this.authorization = null;
    this.name = null;
    this.initialized = false;
  }

  initialize(options:TelemetryOptions) {
    this.workspace = options.workspace;
    this.authorization = options.authorization;
    this.name = options.name;
    if (process.env.BL_DEBUG_TELEMETRY) {
      diag.setLogger(new DiagConsoleLogger(), {logLevel: DiagLogLevel.DEBUG})
    }
    if (!this.enabled || this.initialized) {
      return;
    }
    this.instrumentApp()
    .then(() => {
      console.debug('Instrumentation initialized')
    })
    .catch((error) => {
      console.error("Error instrumenting app:", error);
    });
    this.setupSignalHandler();
    this.otelLogger = logs.getLogger("blaxel");
    this.initialized = true;
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getLogger(): Promise<Logger> {
    if (!this.otelLogger) {
      await this.sleep(100)
      return this.getLogger()
    }
    return this.otelLogger;
  }

  setupSignalHandler() {
    process.on("SIGINT", () => {
      this.shutdownApp().catch((error) => {
        console.debug("Fatal error during shutdown:", error);
        process.exit(0);
      });
    });
    process.on("SIGTERM", () => {
      this.shutdownApp().catch((error) => {
        console.debug("Fatal error during shutdown:", error);
        process.exit(0);
      });
    });
  }

  /**
   * Get resource attributes for OpenTelemetry.
   */
  async getResourceAttributes() {
    const resource = await envDetector.detect();
    const attributes = resource.attributes
    if (this.name) {
      attributes["service.name"] = this.name;
    }
    if (this.workspace) {
      attributes["workspace"] = this.workspace;
    }
    return attributes;
  }

  /**
   * Initialize and return the OTLP Metric Exporter.
   */
  async getMetricExporter() {
    return new OTLPMetricExporter({
      headers: this.authHeaders,
    });
  }

  /**
   * Initialize and return the OTLP Trace Exporter.
   */
  async getTraceExporter() {
    return new OTLPTraceExporter({
      headers: this.authHeaders,
    });
  }

  /**
   * Initialize and return the OTLP Log Exporter.
   */
  async getLogExporter() {
    return new OTLPLogExporter({
      headers: this.authHeaders,
    });
  }

  async instrumentApp() {
    const pinoInstrumentation = new PinoInstrumentation();
    const fastifyInstrumentation = new FastifyInstrumentation();
    const httpInstrumentation = new HttpInstrumentation();
    const instrumentations = await this.loadInstrumentation();

    instrumentations.push(fastifyInstrumentation);
    instrumentations.push(httpInstrumentation);
    instrumentations.push(pinoInstrumentation);

    const resource = new Resource(await this.getResourceAttributes());

    const logExporter = await this.getLogExporter();
    this.loggerProvider = new LoggerProvider({
      resource,
    });
    this.loggerProvider.addLogRecordProcessor(
      new BatchLogRecordProcessor(logExporter)
    );
    logs.setGlobalLoggerProvider(this.loggerProvider);

    const traceExporter = await this.getTraceExporter();

    this.nodeTracerProvider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    this.nodeTracerProvider.register();

    const metricExporter = await this.getMetricExporter();
    this.meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 })],
    });
    metrics.setGlobalMeterProvider(this.meterProvider);

    registerInstrumentations({
      instrumentations: instrumentations,
    });

  }

  async loadInstrumentation(): Promise<Instrumentation[]> {
    const instrumentations: Instrumentation[] = [];
    for (const [name, info] of Object.entries(instrumentationMap)) {
      if (info.requiredPackages.some((pkg) => this.isPackageInstalled(pkg))) {
        const module = await this.importInstrumentationClass(
          info.modulePath,
          info.className
        );
        if (module) {
          try {
            const instrumentor = new module() as Instrumentation;
            instrumentor.enable();
            instrumentations.push(instrumentor);
            if (name === "langchain") {
              const langchain = instrumentor as LangChainInstrumentation;

              const RunnableModule = require("@langchain/core/runnables");
              const ToolsModule = require("@langchain/core/tools");
              const ChainsModule = require("langchain/chains");
              const AgentsModule = require("langchain/agents");
              const VectorStoresModule = require("@langchain/core/vectorstores");

              langchain.manuallyInstrument({
                runnablesModule: RunnableModule,
                toolsModule: ToolsModule,
                chainsModule: ChainsModule,
                agentsModule: AgentsModule,
                vectorStoreModule: VectorStoresModule,
              });
            }
          } catch (error) {
            console.debug(`Failed to instrument ${name}: ${error}`);
          }
        }
      }
    }
    return instrumentations;
  }

  isPackageInstalled(packageName: string): boolean {
    try {
      require.resolve(packageName);
      return true;
    } catch {
      return false;
    }
  }

  async importInstrumentationClass(modulePath: string, className: string): Promise<any> {
    try {
      const module = await import(modulePath);
      return module[className];
    } catch (e) {
      console.debug(`Could not import ${className} from ${modulePath}: ${e}`);
      return null;
    }
  }

  async shutdownApp() {
    try {
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
      console.debug('Instrumentation shutdown complete')

      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  }
}

export const telemetryManager = new TelemetryManager();