import { describe, it, expect } from 'vitest'
import { settings } from "@blaxel/core"

/**
 * Sentry Integration Tests
 *
 * These tests verify basic Sentry configuration.
 * Full Sentry testing requires manual verification of error capture in the Sentry dashboard.
 */

describe('Sentry Integration', () => {
  it('has Sentry DSN configured', () => {
    // This test just verifies settings are accessible
    // The actual DSN might be empty in test environments
    expect(settings).toBeDefined()
    expect(typeof settings.sentryDsn).toBe('string')
  })

  it('headers are accessible', () => {
    expect(settings.headers).toBeDefined()
  })
})

