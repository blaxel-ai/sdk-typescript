import { BlaxelSpan, BlaxelSpanOptions, BlaxelTelemetryProvider } from "@blaxel/core";
import {
  Span as OtelApiSpan,
  context as otelContext, SpanOptions as OtelSpanOptions, SpanStatusCode, trace
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
    Object.entries(attributes).forEach(([k, v]) => this.span.setAttribute(k, v));
  }

  recordException(error: Error): void {
    this.span.recordException(error);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  setStatus(status: 'ok' | 'error', message?: string): void {
    this.span.setStatus({
      code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
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

    // Handle parent context if provided
    let ctx = otelContext.active();
    if (options?.parentContext) {
      ctx = options.parentContext as typeof ctx;
    }

    // Start the span
    const span = tracer.startSpan(name, otelOptions, ctx);
    return new OtelSpan(span);
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}