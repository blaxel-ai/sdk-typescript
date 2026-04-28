import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from './env.js';

describe('Settings.apiVersion', () => {
  beforeEach(() => {
    // Reset the module-level settings singleton between tests if needed
  });

  afterEach(() => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
  });

  it('defaults to 2026-04-16 when BL_API_VERSION is not set', async () => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
    const { settings } = await import('./settings.js');
    expect(settings.apiVersion).toBe('2026-04-16');
  });

  it('headers include Blaxel-Version set to the default', async () => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
    const { settings } = await import('./settings.js');
    expect(settings.headers['Blaxel-Version']).toBe('2026-04-16');
  });
});
