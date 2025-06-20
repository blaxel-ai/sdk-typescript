// @blaxel/core/src/telemetry/interface.ts

/**
 * Options for creating a span
 */
export interface BlaxelSpanOptions {
  /** Key-value attributes to attach to the span */
  attributes?: Record<string, string | number | boolean>;
  /** Parent span context, if any */
  parentContext?: unknown;
  /** Whether this is a root span */
  isRoot?: boolean;
}

/**
 * Represents a telemetry span
 */
export interface BlaxelSpan {
  /** Add an attribute to the span */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Add multiple attributes to the span */
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  /** Record an error on the span */
  recordException(error: Error): void;
  /** Set the status of the span */
  setStatus(status: "ok" | "error", message?: string): void;
  /** End the span */
  end(): void;
  /** Get the span context (for passing to child spans) */
  getContext(): unknown;
}

/**
 * Provider interface for telemetry functionality
 */
export interface BlaxelTelemetryProvider {
  /** Create a new span */
  startSpan(name: string, options?: BlaxelSpanOptions): BlaxelSpan;
  /** Flush the telemetry provider */
  flush(): Promise<void>;
  /** Extract context from headers for manual context propagation */
  extractContextFromHeaders?(
    headers: Record<string, string | string[]>
  ): unknown;
}

/**
 * No-operation implementation of Span
 */
class NoopSpan implements BlaxelSpan {
  setAttribute(): void {}
  setAttributes(): void {}
  recordException(): void {}
  setStatus(): void {}
  end(): void {}
  getContext(): unknown {
    return null;
  }
}

/**
 * No-operation implementation of TelemetryProvider
 */
class NoopTelemetryProvider implements BlaxelTelemetryProvider {
  startSpan(): BlaxelSpan {
    return new NoopSpan();
  }
  async flush(): Promise<void> {}
  extractContextFromHeaders(): unknown {
    return null;
  }
}

/**
 * Registry for telemetry providers
 */
class TelemetryRegistry {
  private provider: BlaxelTelemetryProvider = new NoopTelemetryProvider();

  registerProvider(provider: BlaxelTelemetryProvider) {
    this.provider = provider;
  }

  getProvider(): BlaxelTelemetryProvider {
    return this.provider;
  }
}

// Global instance
export const telemetryRegistry = new TelemetryRegistry();

// Convenience functions that delegate to the provider

/**
 * Create a span with the registered provider
 */
export function startSpan(
  name: string,
  options?: BlaxelSpanOptions
): BlaxelSpan {
  return telemetryRegistry.getProvider().startSpan(name, options);
}

export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  options?: BlaxelSpanOptions
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await fn();
    span.end();
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.end();
    throw error;
  }
}

/**
 * Extract context from headers - useful for manual context propagation
 * when you have traceparent headers but no active span
 */
export function extractContextFromHeaders(
  headers: Record<string, string | string[]>
): unknown {
  const provider = telemetryRegistry.getProvider();
  if (provider.extractContextFromHeaders) {
    return provider.extractContextFromHeaders(headers);
  }
  return null;
}

/**
 * Create a span with extracted context from headers
 * This is useful when you need to manually establish trace context
 */
export function startSpanWithHeaders(
  name: string,
  headers: Record<string, string | string[]>,
  options?: Omit<BlaxelSpanOptions, "parentContext">
): BlaxelSpan {
  const extractedContext = extractContextFromHeaders(headers);
  return startSpan(name, {
    ...options,
    parentContext: extractedContext || undefined,
  });
}
