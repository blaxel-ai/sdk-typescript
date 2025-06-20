import {
  BlaxelSpan,
  BlaxelSpanOptions,
  BlaxelTelemetryProvider,
  logger,
} from "@blaxel/core";
import {
  Span as OtelApiSpan,
  context as otelContext,
  SpanOptions as OtelSpanOptions,
  SpanStatusCode,
  trace,
  propagation,
} from "@opentelemetry/api";
import { blaxelTelemetry } from "./telemetry";

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
    // Use the tracer from the registered NodeTracerProvider
    const tracer = trace.getTracer("blaxel");

    // Get the current active context
    let ctx = otelContext.active();
    const activeSpan = trace.getActiveSpan();

    // Log context information for debugging
    if (activeSpan) {
      const spanContext = activeSpan.spanContext();
      logger.debug("Creating span with active parent context", {
        spanName: name,
        parentTraceId: spanContext.traceId,
        parentSpanId: spanContext.spanId,
        isRoot: options?.isRoot,
      });
    } else {
      logger.debug("Creating span without active parent context", {
        spanName: name,
        isRoot: options?.isRoot,
        contextProvided: !!options?.parentContext,
      });

      // Try to extract context from headers if available in the environment
      // This is a fallback when HttpInstrumentation doesn't set the context properly
      if (typeof globalThis !== "undefined" && globalThis.process?.env) {
        const headers: Record<string, string> = {};
        // Check if there are any trace headers in the environment
        if (process.env.TRACEPARENT) {
          headers["traceparent"] = process.env.TRACEPARENT;
        }
        if (process.env.TRACESTATE) {
          headers["tracestate"] = process.env.TRACESTATE;
        }

        if (headers.traceparent) {
          logger.debug(
            "Found traceparent in environment, attempting to extract context",
            {
              traceparent: headers.traceparent,
              tracestate: headers.tracestate,
            }
          );

          try {
            const extractedContext = propagation.extract(
              otelContext.active(),
              headers
            );
            const extractedSpan = trace.getSpan(extractedContext);
            if (extractedSpan) {
              ctx = extractedContext;
              logger.debug("Successfully extracted context from traceparent", {
                extractedTraceId: extractedSpan.spanContext().traceId,
                extractedSpanId: extractedSpan.spanContext().spanId,
              });
            }
          } catch (error) {
            logger.debug("Failed to extract context from traceparent", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    // Handle parent context if provided
    if (options?.parentContext) {
      ctx = options.parentContext as typeof ctx;
      logger.debug("Using provided parent context for span", {
        spanName: name,
      });
    }

    // Prepare OpenTelemetry span options
    const otelOptions: OtelSpanOptions = {
      attributes: options?.attributes,
      root: options?.isRoot,
    };

    // Start the span
    const span = tracer.startSpan(name, otelOptions, ctx);
    const spanContext = span.spanContext();

    logger.debug("Span created successfully", {
      spanName: name,
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      isRoot: options?.isRoot,
    });

    return new OtelSpan(span);
  }

  /**
   * Extract context from headers manually
   * This can be used when automatic context propagation isn't working
   */
  extractContextFromHeaders(
    headers: Record<string, string | string[]>
  ): unknown {
    try {
      // Normalize headers to string values
      const normalizedHeaders: Record<string, string> = {};
      Object.entries(headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          normalizedHeaders[key.toLowerCase()] = value[0] || "";
        } else if (typeof value === "string") {
          normalizedHeaders[key.toLowerCase()] = value;
        }
      });

      logger.debug("Attempting to extract context from headers", {
        headers: Object.keys(normalizedHeaders),
        traceparent: normalizedHeaders.traceparent,
        tracestate: normalizedHeaders.tracestate,
      });

      const extractedContext = propagation.extract(
        otelContext.active(),
        normalizedHeaders
      );
      const extractedSpan = trace.getSpan(extractedContext);

      if (extractedSpan) {
        const spanContext = extractedSpan.spanContext();
        logger.debug("Successfully extracted context from headers", {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        });
        return extractedContext;
      } else {
        logger.debug("No span found in extracted context");
        return null;
      }
    } catch (error) {
      logger.debug("Failed to extract context from headers", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}
