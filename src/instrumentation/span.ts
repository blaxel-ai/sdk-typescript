import { Span, trace, Tracer } from "@opentelemetry/api";
import { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import settings from "../common/settings";

export class DefaultAttributesSpanProcessor implements SpanProcessor {
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

export class SpanManager {
  private tracer: Tracer;

  constructor(name: string) {
    this.tracer = trace.getTracer(name);
  }

  createActiveSpan(name: string, attributes: Record<string, string>, fn: (span: Span) => Promise<any>) : Promise<any> {
    attributes["blaxel.environment"] = settings.env
    attributes["workload.id"] = settings.name
    attributes["workload.type"] = settings.type+"s"
    attributes["workspace"] = settings.workspace
    const span = this.tracer.startActiveSpan(name, {attributes}, async (span) => {
      try {
        const res = await fn(span)
        span.end()
        return res
      } catch (err: any) {
        span.recordException(err)
        span.end()
        throw err
      }
    })
    return span
  }

  createSpan(name: string, attributes: Record<string, any>, parent?: Span) : Span {
    return this.tracer.startSpan(name, {
      attributes: {
        ...attributes,
        "blaxel.environment": settings.env,
        "workload.id": settings.name,
        "workload.type": settings.type+"s",
        "workspace": settings.workspace
      },
      ...(parent ? { parent } : {})
    });
  }
}
