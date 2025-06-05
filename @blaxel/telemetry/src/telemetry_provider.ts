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

    // Prepare OpenTelemetry span options
    const otelOptions: OtelSpanOptions = {
      attributes: options?.attributes,
      root: options?.isRoot,
    };

    // Handle parent context properly
    let ctx = otelContext.active();

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
    return new OtelSpan(span);
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}
