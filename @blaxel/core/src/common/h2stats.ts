import { logger } from "./logger.js";
import { reportH2TransportDegradation } from "./sentry.js";

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

const emptyReasons = (): Record<H2FallbackReason, number> => ({
  "no-session": 0,
  "request-rejected": 0,
  "session-unusable": 0,
  "unsupported-body": 0,
});

const MAX_TRACKED_DOMAINS = 100;
const H2_DEBUG_STATS_SYMBOL = Symbol.for("blaxel.h2stats");
const h2DebugStatsEnabled =
  typeof process !== "undefined" && process.env?.BL_H2_DEBUG_STATS === "1";

function publishDebugSnapshot(snapshot: H2TransportStatsSnapshot): void {
  if (!h2DebugStatsEnabled) return;
  try {
    (globalThis as unknown as Record<symbol, unknown>)[H2_DEBUG_STATS_SYMBOL] = snapshot;
  } catch {
    // Debug diagnostics must never change transport behavior.
  }
}

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
    publishDebugSnapshot(this.snapshot());
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
    reportH2TransportDegradation(domain, "establish-failure");
    publishDebugSnapshot(this.snapshot());
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
    reportH2TransportDegradation(domain, reason);
    publishDebugSnapshot(this.snapshot());
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
publishDebugSnapshot(store.snapshot());

/** @internal */
export function snapshotH2TransportStats(): H2TransportStatsSnapshot {
  return store.snapshot();
}

/** @internal */
export function resetH2TransportStats(): void {
  store.reset();
}

/** @internal */
export function recordH2EstablishFailure(domain: string, error: unknown): void {
  store.recordEstablishFailure(domain, error);
}

/** @internal */
export function recordH2Fallback(domain: string, reason: H2FallbackReason): void {
  store.recordFallback(domain, reason);
}
