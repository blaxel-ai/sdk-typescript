import { logger } from "./logger.js";

export type H2FallbackReason =
  | "no-session"
  | "request-rejected"
  | "session-unusable"
  | "unsupported-body";

export type H2TransportDomainStats = {
  establishFailures: number;
  fetchFallbacks: number;
  fallbacksByReason: Record<H2FallbackReason, number>;
};

export type H2TransportStatsSnapshot = H2TransportDomainStats & {
  byDomain: Record<string, H2TransportDomainStats>;
};

export type H2TransportStats = {
  /** Return a detached snapshot of process-wide H2 transport counters. */
  snapshot(): H2TransportStatsSnapshot;
  /** Clear all process-wide H2 transport counters. */
  reset(): void;
};

const emptyReasons = (): Record<H2FallbackReason, number> => ({
  "no-session": 0,
  "request-rejected": 0,
  "session-unusable": 0,
  "unsupported-body": 0,
});

const MAX_TRACKED_DOMAINS = 100;

const emptyDomainStats = (): H2TransportDomainStats => ({
  establishFailures: 0,
  fetchFallbacks: 0,
  fallbacksByReason: emptyReasons(),
});

class H2TransportStatsStore {
  private totals = emptyDomainStats();
  private byDomain = new Map<string, H2TransportDomainStats>();

  snapshot(): H2TransportStatsSnapshot {
    return {
      ...this.clone(this.totals),
      byDomain: Object.fromEntries(
        [...this.byDomain].map(([domain, stats]) => [domain, this.clone(stats)]),
      ),
    };
  }

  reset(): void {
    this.totals = emptyDomainStats();
    this.byDomain.clear();
  }

  /** @internal */
  recordEstablishFailure(domain: string, error: unknown): void {
    this.totals.establishFailures++;
    this.forDomain(domain).establishFailures++;
    try {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`H2 session establishment failed for ${domain}: ${message}`);
    } catch {
      // Diagnostics must never change transport behavior.
    }
  }

  /** @internal */
  recordFallback(domain: string, reason: H2FallbackReason): void {
    this.totals.fetchFallbacks++;
    this.totals.fallbacksByReason[reason]++;
    const stats = this.forDomain(domain);
    stats.fetchFallbacks++;
    stats.fallbacksByReason[reason]++;
    try {
      logger.debug(`H2 transport falling back to fetch for ${domain}: ${reason}`);
    } catch {
      // Diagnostics must never change transport behavior.
    }
  }

  private forDomain(domain: string): H2TransportDomainStats {
    let stats = this.byDomain.get(domain);
    if (stats) {
      this.byDomain.delete(domain);
    } else {
      if (this.byDomain.size >= MAX_TRACKED_DOMAINS) {
        const oldest = this.byDomain.keys().next().value;
        if (oldest !== undefined) this.byDomain.delete(oldest);
      }
      stats = emptyDomainStats();
    }
    this.byDomain.set(domain, stats);
    return stats;
  }

  private clone(stats: H2TransportDomainStats): H2TransportDomainStats {
    return {
      establishFailures: stats.establishFailures,
      fetchFallbacks: stats.fetchFallbacks,
      fallbacksByReason: { ...stats.fallbacksByReason },
    };
  }
}

const store = new H2TransportStatsStore();

/**
 * Process-wide H2 counters with aggregate totals and the 100 most recently
 * observed domains. Call reset() before taking an isolated measurement.
 */
export const h2TransportStats: H2TransportStats = store;

/** @internal */
export function recordH2EstablishFailure(domain: string, error: unknown): void {
  store.recordEstablishFailure(domain, error);
}

/** @internal */
export function recordH2Fallback(domain: string, reason: H2FallbackReason): void {
  store.recordFallback(domain, reason);
}
