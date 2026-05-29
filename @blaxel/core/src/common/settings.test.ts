import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiKey } from '../authentication/apikey.js';
import { env } from './env.js';

describe('Settings.apiVersion', () => {
  beforeEach(() => {
    // Reset the module-level settings singleton between tests if needed
  });

  afterEach(() => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
  });

  it('defaults to 2026-04-28 when BL_API_VERSION is not set', async () => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
    const { settings } = await import('./settings.js');
    expect(settings.apiVersion).toBe('2026-04-28');
  });

  it('headers include Blaxel-Version set to the default', async () => {
    delete (env as Record<string, unknown>).BL_API_VERSION;
    const { settings } = await import('./settings.js');
    // headers now requires resolvable credentials; run in an authenticated context
    const previous = settings.credentials;
    settings.credentials = new ApiKey({ apiKey: 'test-key', workspace: 'test-ws' });
    try {
      expect(settings.headers['Blaxel-Version']).toBe('2026-04-28');
    } finally {
      settings.credentials = previous;
    }
  });
});
