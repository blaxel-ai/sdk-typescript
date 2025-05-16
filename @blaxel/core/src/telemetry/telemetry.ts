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
  setStatus(status: 'ok' | 'error', message?: string): void;
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
  getContext(): unknown { return null; }
}

/**
 * No-operation implementation of TelemetryProvider
 */
class NoopTelemetryProvider implements BlaxelTelemetryProvider {
  startSpan(): BlaxelSpan {
    return new NoopSpan();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Registry for managing the global telemetry provider
 */
class TelemetryRegistry {
  private static instance: TelemetryRegistry;
  private provider: BlaxelTelemetryProvider = new NoopTelemetryProvider();

  private constructor() {}

  static getInstance(): TelemetryRegistry {
    if (!TelemetryRegistry.instance) {
      TelemetryRegistry.instance = new TelemetryRegistry();
    }
    return TelemetryRegistry.instance;
  }

  /**
   * Register a telemetry provider implementation
   */
  registerProvider(provider: BlaxelTelemetryProvider): void {
    this.provider = provider;
  }

  /**
   * Get the current telemetry provider
   */
  getProvider(): BlaxelTelemetryProvider {
    return this.provider;
  }
}

// Export singleton instance
export const telemetryRegistry = TelemetryRegistry.getInstance();

// Convenience functions that delegate to the provider

/**
 * Create a span with the registered provider
 */
export function startSpan(name: string, options?: BlaxelSpanOptions): BlaxelSpan {
  return telemetryRegistry.getProvider().startSpan(name, options);
}

export async function withSpan<T>(name: string, fn: () => Promise<T>, options?: BlaxelSpanOptions): Promise<T> {
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

export async function flush() {
  await telemetryRegistry.getProvider().flush();
}