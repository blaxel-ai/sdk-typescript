import {
  BlaxelSpan,
  BlaxelSpanOptions,
  BlaxelTelemetryProvider,
} from "@blaxel/core";
import {
  Span as OtelApiSpan,
  context as otelContext,
  SpanOptions as OtelSpanOptions,
  SpanStatusCode,
  trace,
  SpanContext,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { blaxelTelemetry } from "./telemetry";
import { logger } from "@blaxel/core";

class OtelSpan implements BlaxelSpan {
  private span: OtelApiSpan;

  constructor(span: OtelApiSpan) {
    this.span = span;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.setAttribute(key, value);
  }

  setAttributes(attributes: Record<string, string | number | boolean>): void {
    Object.entries(attributes).forEach(([k, v]) =>
      this.span.setAttribute(k, v)
    );
  }

  recordException(error: Error): void {
    this.span.recordException(error);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  setStatus(status: "ok" | "error", message?: string): void {
    this.span.setStatus({
      code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message,
    });
  }

  end(): void {
    this.span.end();
  }

  getContext(): unknown {
    return this.span.spanContext();
  }
}

export class OtelTelemetryProvider implements BlaxelTelemetryProvider {
  startSpan(name: string, options?: BlaxelSpanOptions): BlaxelSpan {
    // Check if telemetry is active, reinitialize if needed
    logger.debug("Telemetry is active:", blaxelTelemetry.isActive);
    if (!blaxelTelemetry.isActive) {
      logger.debug("Telemetry not active, reinitializing...");
      // Synchronous reinitialize - just call initialize, setConfiguration will happen async
      blaxelTelemetry.initialize();
    }

    // Use the tracer from the registered NodeTracerProvider
    const tracer = trace.getTracer("blaxel");

    // Prepare OpenTelemetry span options
    const otelOptions: OtelSpanOptions = {
      attributes: options?.attributes,
      root: options?.isRoot,
    };

    logger.debug(
      "Options:",
      options
        ? {
            attributes: options.attributes,
            isRoot: options.isRoot,
            hasParentContext: !!options.parentContext,
          }
        : null
    );
    logger.debug("OTel span options:", otelOptions);

    // Handle parent context properly with debugging
    let ctx = otelContext.active();
    const activeSpan = trace.getActiveSpan();

    logger.debug("Active context keys:", Object.keys(ctx));
    logger.debug(
      "Active span:",
      activeSpan
        ? {
            spanId: activeSpan.spanContext().spanId,
            traceId: activeSpan.spanContext().traceId,
          }
        : null
    );
    logger.debug(
      "Active span context:",
      activeSpan ? activeSpan.spanContext() : null
    );

    // Debug logging for context issues
    logger.info(`Creating span "${name}":`, {
      hasActiveSpan: !!activeSpan,
      activeSpanId: activeSpan?.spanContext().spanId,
      isRoot: options?.isRoot,
      hasParentContext: !!options?.parentContext,
      parentContext: options?.parentContext,
      contextKeys: Object.keys(ctx),
      telemetryActive: blaxelTelemetry.isActive,
      activeTraceId: activeSpan?.spanContext().traceId,
      otelOptions: otelOptions,
    });

    if (options?.parentContext) {
      // If explicit parent context is provided, use it
      ctx = trace.setSpanContext(
        ROOT_CONTEXT,
        options.parentContext as SpanContext
      );
    } else if (options?.isRoot) {
      // If explicitly marked as root, use ROOT_CONTEXT
      ctx = ROOT_CONTEXT;
    }
    // Otherwise, use the active context (default behavior)

    // Start the span with proper context
    const span = tracer.startSpan(name, otelOptions, ctx);
    const otelSpan = new OtelSpan(span);

    // Safe logging of span information without circular references
    const spanContext = span.spanContext();
    logger.debug("Span created:", {
      spanId: spanContext.spanId,
      traceId: spanContext.traceId,
      traceFlags: spanContext.traceFlags,
    });
    logger.debug("Span context:", spanContext);

    // Additional debugging
    logger.info(`Created span "${name}":`, {
      spanId: spanContext.spanId,
      traceId: spanContext.traceId,
      parentSpanId: activeSpan?.spanContext().spanId || "none",
    });

    return otelSpan;
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}
