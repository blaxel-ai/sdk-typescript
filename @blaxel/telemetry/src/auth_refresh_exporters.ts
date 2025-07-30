import { authenticate, logger, settings } from "@blaxel/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";

/**
 * SpanExporter that refreshes authentication before each export.
 * This is necessary for long-running containers where tokens may expire.
 */
export class AuthRefreshingSpanExporter implements SpanExporter {
  constructor(private createExporter: () => SpanExporter) {
    logger.debug("[AuthRefreshingSpanExporter] Initialized");
  }

  private currentExporter: SpanExporter | null = null;

  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    logger.debug(`[AuthRefreshingSpanExporter] Exporting ${spans.length} spans`);

    // Execute async operations but return void as required by interface
    this.doExport(spans, resultCallback).catch(error => {
      logger.error("[AuthRefreshingSpanExporter] Fatal error in export:", error);
      resultCallback({ code: 1, error: error as Error });
    });
  }

  private async doExport(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): Promise<void> {
    try {
      logger.debug("[AuthRefreshingSpanExporter] Starting authentication refresh");

      const startTime = Date.now();

      // Always refresh auth before export
      await authenticate();

      const authTime = Date.now() - startTime;
      logger.debug(`[AuthRefreshingSpanExporter] Authentication completed in ${authTime}ms`);

      // Log current auth status
      if (settings.authorization) {
        logger.debug("[AuthRefreshingSpanExporter] Authorization token is present");
      } else {
        logger.warn("[AuthRefreshingSpanExporter] No authorization token after authentication!");
      }

      logger.debug("[AuthRefreshingSpanExporter] Creating new exporter");

      // Create new exporter with fresh headers
      this.currentExporter = this.createExporter();

      logger.debug("[AuthRefreshingSpanExporter] New exporter created with fresh auth headers");

      // Export using the fresh exporter
      if (this.currentExporter && this.currentExporter.export) {
        logger.debug("[AuthRefreshingSpanExporter] Calling export on fresh exporter");
        this.currentExporter.export(spans, resultCallback);
      } else {
        const error = new Error('Exporter not initialized');
        logger.error("[AuthRefreshingSpanExporter] Exporter not properly initialized", error);
        resultCallback({ code: 1, error });
      }
    } catch (error) {
      logger.error("[AuthRefreshingSpanExporter] Error during authentication or export:", error);
      logger.error("[AuthRefreshingSpanExporter] Error details:", {
        message: (error as Error).message,
        stack: (error as Error).stack
      });
      resultCallback({ code: 1, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {
    logger.debug("[AuthRefreshingSpanExporter] Shutting down");
    if (this.currentExporter) {
      return this.currentExporter.shutdown();
    }
  }

  async forceFlush(): Promise<void> {
    logger.debug("[AuthRefreshingSpanExporter] Force flushing");
    if (this.currentExporter && this.currentExporter.forceFlush) {
      return this.currentExporter.forceFlush();
    }
  }
}

/**
 * MetricExporter that refreshes authentication before each export.
 * This is necessary for long-running containers where tokens may expire.
 */
export class AuthRefreshingMetricExporter {
  constructor(private createExporter: () => OTLPMetricExporter) {
    logger.debug("[AuthRefreshingMetricExporter] Initialized");
  }

  private currentExporter: OTLPMetricExporter | null = null;

  export(metrics: ResourceMetrics, resultCallback: (result: { code: number; error?: Error }) => void): void {
    logger.debug("[AuthRefreshingMetricExporter] Exporting metrics");

    // Execute async operations but return void
    this.doExport(metrics, resultCallback).catch(error => {
      logger.error("[AuthRefreshingMetricExporter] Fatal error in export:", error);
      resultCallback({ code: 1, error: error as Error });
    });
  }

  private async doExport(metrics: ResourceMetrics, resultCallback: (result: { code: number; error?: Error }) => void): Promise<void> {
    try {
      logger.debug("[AuthRefreshingMetricExporter] Starting authentication refresh");

      const startTime = Date.now();

      // Always refresh auth before export
      await authenticate();

      const authTime = Date.now() - startTime;
      logger.debug(`[AuthRefreshingMetricExporter] Authentication completed in ${authTime}ms`);

      // Log current auth status
      if (settings.authorization) {
        logger.debug("[AuthRefreshingMetricExporter] Authorization token is present");
      } else {
        logger.warn("[AuthRefreshingMetricExporter] No authorization token after authentication!");
      }

      logger.debug("[AuthRefreshingMetricExporter] Creating new exporter");

      // Create new exporter with fresh headers
      this.currentExporter = this.createExporter();

      logger.debug("[AuthRefreshingMetricExporter] New exporter created with fresh auth headers");

      // Export using the fresh exporter
      if (this.currentExporter && this.currentExporter.export) {
        logger.debug("[AuthRefreshingMetricExporter] Calling export on fresh exporter");
        this.currentExporter.export(metrics, resultCallback);
      } else {
        const error = new Error('Exporter not initialized');
        logger.error("[AuthRefreshingMetricExporter] Exporter not properly initialized", error);
        resultCallback({ code: 1, error });
      }
    } catch (error) {
      logger.error("[AuthRefreshingMetricExporter] Error during authentication or export:", error);
      logger.error("[AuthRefreshingMetricExporter] Error details:", {
        message: (error as Error).message,
        stack: (error as Error).stack
      });
      resultCallback({ code: 1, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {
    logger.debug("[AuthRefreshingMetricExporter] Shutting down");
    if (this.currentExporter) {
      return this.currentExporter.shutdown();
    }
  }

  async forceFlush(): Promise<void> {
    logger.debug("[AuthRefreshingMetricExporter] Force flushing");
    if (this.currentExporter && this.currentExporter.forceFlush) {
      return this.currentExporter.forceFlush();
    }
  }
}

/**
 * Creates an OTLP Trace Exporter with the current auth headers
 */
export function createTraceExporter(): OTLPTraceExporter {
  const headers: Record<string, string> = {};
  if (settings.authorization) {
    headers["x-blaxel-authorization"] = settings.authorization;
    logger.debug("[createTraceExporter] Added authorization header");
  } else {
    logger.warn("[createTraceExporter] No authorization available");
  }

  if (settings.workspace) {
    headers["x-blaxel-workspace"] = settings.workspace;
    logger.debug(`[createTraceExporter] Added workspace header: ${settings.workspace}`);
  } else {
    logger.warn("[createTraceExporter] No workspace available");
  }

  logger.debug("[createTraceExporter] Creating OTLPTraceExporter with headers:", Object.keys(headers));

  return new OTLPTraceExporter({
    headers,
  });
}

/**
 * Creates an OTLP Metric Exporter with the current auth headers
 */
export function createMetricExporter(): OTLPMetricExporter {
  const headers: Record<string, string> = {};
  if (settings.authorization) {
    headers["x-blaxel-authorization"] = settings.authorization;
    logger.debug("[createMetricExporter] Added authorization header");
  } else {
    logger.warn("[createMetricExporter] No authorization available");
  }

  if (settings.workspace) {
    headers["x-blaxel-workspace"] = settings.workspace;
    logger.debug(`[createMetricExporter] Added workspace header: ${settings.workspace}`);
  } else {
    logger.warn("[createMetricExporter] No workspace available");
  }

  logger.debug("[createMetricExporter] Creating OTLPMetricExporter with headers:", Object.keys(headers));

  return new OTLPMetricExporter({
    headers,
  });
}
