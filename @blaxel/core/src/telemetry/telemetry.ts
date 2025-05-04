// @blaxel/core/src/telemetry/interface.ts

/**
 * Options for creating a span
 */
export interface SpanOptions {
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
export interface Span {
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
export interface TelemetryProvider {
  /** Create a new span */
  startSpan(name: string, options?: SpanOptions): Span;
}

/**
 * No-operation implementation of Span
 */
class NoopSpan implements Span {
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
class NoopTelemetryProvider implements TelemetryProvider {
  startSpan(): Span {
    return new NoopSpan();
  }
}

/**
 * Registry for managing the global telemetry provider
 */
class TelemetryRegistry {
  private static instance: TelemetryRegistry;
  private provider: TelemetryProvider = new NoopTelemetryProvider();

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
  registerProvider(provider: TelemetryProvider): void {
    this.provider = provider;
  }

  /**
   * Get the current telemetry provider
   */
  getProvider(): TelemetryProvider {
    return this.provider;
  }
}

// Export singleton instance
export const telemetryRegistry = TelemetryRegistry.getInstance();

// Convenience functions that delegate to the provider

/**
 * Create a span with the registered provider
 */
export function startSpan(name: string, options?: SpanOptions): Span {
  return telemetryRegistry.getProvider().startSpan(name, options);
}