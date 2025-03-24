import { Span, trace, Tracer } from "@opentelemetry/api";
import settings from "../common/settings";

export class SpanManager {
  private tracer: Tracer;

  constructor(name: string) {
    this.tracer = trace.getTracer(name);
  }

  createSpan(name: string, attributes: Record<string, any>, parent?: Span) : Span {
    return this.tracer.startSpan(name, {
      attributes: {
        ...attributes,
        "blaxel.environment": settings.env,
        "workload.id": settings.name,
        "workload.type": settings.type,
        "workspace": settings.workspace
      },
      ...(parent ? { parent } : {})
    });
  }
}
