import { BlaxelSpan, BlaxelSpanOptions, BlaxelTelemetryProvider } from "@blaxel/core";
import {
  Span as OtelApiSpan,
  context as otelContext,
  SpanOptions as OtelSpanOptions,
  ROOT_CONTEXT,
  SpanContext,
  SpanStatusCode, trace
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
    this.closed = true;
    this.span.end();
  }

  getContext(): unknown {
    return this.span.spanContext();
  }
}

export class OtelTelemetryProvider implements BlaxelTelemetryProvider {
  private spans: OtelSpan[] = [];

  retrieveActiveSpanContext() {
    for(let i = this.spans.length - 1; i >= 0; i--) {
      const span = this.spans[i];
      if(!span.closed) {
        return trace.setSpanContext(ROOT_CONTEXT, span.getContext() as SpanContext);
      }
    }
    return otelContext.active();
  }

  startSpan(name: string, options?: BlaxelSpanOptions): BlaxelSpan {
    const tracer = trace.getTracer("blaxel");

    const otelOptions: OtelSpanOptions = {
      attributes: options?.attributes,
      root: options?.isRoot,
    };

    const ctx = this.retrieveActiveSpanContext();
    const span = new OtelSpan(tracer.startSpan(name, otelOptions, ctx));
    this.spans.push(span);

    return span;
  }

  async flush(): Promise<void> {
    await blaxelTelemetry.flush();
  }
}