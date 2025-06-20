import {
  BlaxelSpan,
  BlaxelSpanOptions,
  BlaxelTelemetryProvider,
} from "@blaxel/core";
import {
  Span as OtelApiSpan,
  context as otelContext,
  SpanOptions as OtelSpanOptions,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { blaxelTelemetry } from "./telemetry";

class OtelSpan implements BlaxelSpan {
  private span: OtelApiSpan;
  public closed = false;

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
    this.closed = true;
    this.span.end();
  }

  getContext(): unknown {
    return this.span.spanContext();
  }
}

export class OtelTelemetryProvider implements BlaxelTelemetryProvider {
  startSpan(name: string, options?: BlaxelSpanOptions): BlaxelSpan {
    const tracer = trace.getTracer("blaxel");

    // Get the current active context - this will include any traceparent propagation
    const activeContext = otelContext.active();
    const activeSpan = trace.getActiveSpan();

    // Debug logging to help understand context propagation
    console.log("=== CREATING NEW SPAN ===");
    console.log("Span name:", name);
    console.log(
      "Active context span:",
      activeSpan
        ? {
            traceId: activeSpan.spanContext().traceId,
            spanId: activeSpan.spanContext().spanId,
            traceFlags: activeSpan.spanContext().traceFlags,
          }
        : "null"
    );

    // Check if there's a span context in the active context (from traceparent headers)
    const spanContext = trace.getSpanContext(activeContext);
    if (spanContext) {
      console.log("Span context from active context:", {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
      });
    }

    const otelOptions: OtelSpanOptions = {
      attributes: options?.attributes,
      root: options?.isRoot,
    };

    // Use the active context unless explicitly requesting a root span
    const contextToUse = options?.isRoot ? ROOT_CONTEXT : activeContext;
    const span = new OtelSpan(
      tracer.startSpan(name, otelOptions, contextToUse)
    );

    console.log("Created span context:", span.getContext());
    console.log("=== END CREATING NEW SPAN ===");

    return span;
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}
