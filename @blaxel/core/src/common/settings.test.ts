import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiKey } from '../authentication/apikey.js';
import { env } from './env.js';
import { isBrokenBunH2Runtime } from './h2-runtime.js';

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

describe('Settings.disableH2', () => {
  afterEach(async () => {
    delete (env as Record<string, unknown>).BL_DISABLE_H2;
    const { settings } = await import('./settings.js');
    delete settings.config.disableH2;
  });

  // On a broken-Bun runtime the getter force-returns true regardless of
  // config/env, so the "H2 on by default" expectations below do not hold there.
  // Use the SAME predicate the getter uses so the skip and the behavior agree.
  const onBrokenBun = isBrokenBunH2Runtime();

  it.skipIf(onBrokenBun)('enables H2 by default', async () => {
    delete (env as Record<string, unknown>).BL_DISABLE_H2;
    const { settings } = await import('./settings.js');
    delete settings.config.disableH2;
    expect(settings.disableH2).toBe(false);
  });

  it.skipIf(onBrokenBun)('allows H2 to be explicitly disabled', async () => {
    const { settings } = await import('./settings.js');
    settings.config.disableH2 = true;
    expect(settings.disableH2).toBe(true);
  });
});

// The H2 tuning knobs all share the same resolution order: an explicit
// `settings.config` value wins, then the env var (`env` reads through to
// process.env), then a hard-coded default. Numeric knobs also reject
// unparseable/out-of-range env strings and fall back to the default. These are
// the values that flow into establishH2 (window sizes) and the per-domain
// concurrency gates, so an off-by-one here silently changes transport behavior.
describe('Settings H2 tuning knobs (config > env > default)', () => {
  // Snapshot every H2 env var so a test that sets one cannot leak into another.
  const H2_ENV_VARS = [
    'BL_DISABLE_CONTROL_PLANE_H2',
    'BL_FORCE_CONTROL_PLANE_H2',
    'BL_MAX_H2_INFLIGHT',
    'BL_MAX_UPLOAD_H2_INFLIGHT',
    'BL_H2_STREAM_WINDOW',
    'BL_H2_CONNECTION_WINDOW',
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of H2_ENV_VARS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of H2_ENV_VARS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    const { settings } = await import('./settings.js');
    delete settings.config.disableControlPlaneH2;
    delete settings.config.forceControlPlaneH2;
    delete settings.config.maxConcurrentH2Requests;
    delete settings.config.maxConcurrentUploadH2Requests;
    delete settings.config.h2StreamWindowSize;
    delete settings.config.h2ConnectionWindowSize;
  });

  describe('disableControlPlaneH2', () => {
    it('defaults to false', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.disableControlPlaneH2).toBe(false);
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE', 'On'])(
      'treats env %s as true',
      async (value) => {
        process.env.BL_DISABLE_CONTROL_PLANE_H2 = value;
        const { settings } = await import('./settings.js');
        expect(settings.disableControlPlaneH2).toBe(true);
      },
    );

    it.each(['0', 'false', 'no', 'off', ''])(
      'treats env %s as false',
      async (value) => {
        process.env.BL_DISABLE_CONTROL_PLANE_H2 = value;
        const { settings } = await import('./settings.js');
        expect(settings.disableControlPlaneH2).toBe(false);
      },
    );

    it('config value wins over the env var', async () => {
      process.env.BL_DISABLE_CONTROL_PLANE_H2 = '1';
      const { settings } = await import('./settings.js');
      settings.config.disableControlPlaneH2 = false;
      expect(settings.disableControlPlaneH2).toBe(false);
    });
  });

  describe('forceControlPlaneH2', () => {
    it('defaults to false', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.forceControlPlaneH2).toBe(false);
    });

    it('reads a truthy env var', async () => {
      process.env.BL_FORCE_CONTROL_PLANE_H2 = 'yes';
      const { settings } = await import('./settings.js');
      expect(settings.forceControlPlaneH2).toBe(true);
    });

    it('config value wins over the env var', async () => {
      process.env.BL_FORCE_CONTROL_PLANE_H2 = '1';
      const { settings } = await import('./settings.js');
      settings.config.forceControlPlaneH2 = false;
      expect(settings.forceControlPlaneH2).toBe(false);
    });
  });

  describe('maxConcurrentH2Requests', () => {
    it('defaults to 0 (unlimited)', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentH2Requests).toBe(0);
    });

    it('parses the env var', async () => {
      process.env.BL_MAX_H2_INFLIGHT = '8';
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentH2Requests).toBe(8);
    });

    it('config value wins over the env var', async () => {
      process.env.BL_MAX_H2_INFLIGHT = '8';
      const { settings } = await import('./settings.js');
      settings.config.maxConcurrentH2Requests = 3;
      expect(settings.maxConcurrentH2Requests).toBe(3);
    });

    it('falls back to the default on an unparseable env var', async () => {
      process.env.BL_MAX_H2_INFLIGHT = 'not-a-number';
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentH2Requests).toBe(0);
    });
  });

  describe('maxConcurrentUploadH2Requests', () => {
    it('defaults to 2 (the measured rapid-reset-safe cap)', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentUploadH2Requests).toBe(2);
    });

    it('parses the env var, including 0 to disable the cap', async () => {
      process.env.BL_MAX_UPLOAD_H2_INFLIGHT = '0';
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentUploadH2Requests).toBe(0);
    });

    it('config value wins over the env var', async () => {
      process.env.BL_MAX_UPLOAD_H2_INFLIGHT = '5';
      const { settings } = await import('./settings.js');
      settings.config.maxConcurrentUploadH2Requests = 4;
      expect(settings.maxConcurrentUploadH2Requests).toBe(4);
    });

    it('falls back to the default on an unparseable env var', async () => {
      process.env.BL_MAX_UPLOAD_H2_INFLIGHT = 'xyz';
      const { settings } = await import('./settings.js');
      expect(settings.maxConcurrentUploadH2Requests).toBe(2);
    });
  });

  describe('h2StreamWindowSize', () => {
    it('defaults to 16 MiB', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.h2StreamWindowSize).toBe(16 * 1024 * 1024);
    });

    it('parses a positive env var', async () => {
      process.env.BL_H2_STREAM_WINDOW = String(4 * 1024 * 1024);
      const { settings } = await import('./settings.js');
      expect(settings.h2StreamWindowSize).toBe(4 * 1024 * 1024);
    });

    it('config value wins over the env var', async () => {
      process.env.BL_H2_STREAM_WINDOW = '123456';
      const { settings } = await import('./settings.js');
      settings.config.h2StreamWindowSize = 654321;
      expect(settings.h2StreamWindowSize).toBe(654321);
    });

    it.each(['0', '-1', 'nan'])(
      'ignores non-positive/unparseable env value %s and uses the default',
      async (value) => {
        process.env.BL_H2_STREAM_WINDOW = value;
        const { settings } = await import('./settings.js');
        expect(settings.h2StreamWindowSize).toBe(16 * 1024 * 1024);
      },
    );
  });

  describe('h2ConnectionWindowSize', () => {
    it('defaults to 32 MiB', async () => {
      const { settings } = await import('./settings.js');
      expect(settings.h2ConnectionWindowSize).toBe(32 * 1024 * 1024);
    });

    it('parses a positive env var', async () => {
      process.env.BL_H2_CONNECTION_WINDOW = String(8 * 1024 * 1024);
      const { settings } = await import('./settings.js');
      expect(settings.h2ConnectionWindowSize).toBe(8 * 1024 * 1024);
    });

    it('config value wins over the env var', async () => {
      process.env.BL_H2_CONNECTION_WINDOW = '111';
      const { settings } = await import('./settings.js');
      settings.config.h2ConnectionWindowSize = 222;
      expect(settings.h2ConnectionWindowSize).toBe(222);
    });

    it.each(['0', '-100', 'foo'])(
      'ignores non-positive/unparseable env value %s and uses the default',
      async (value) => {
        process.env.BL_H2_CONNECTION_WINDOW = value;
        const { settings } = await import('./settings.js');
        expect(settings.h2ConnectionWindowSize).toBe(32 * 1024 * 1024);
      },
    );
  });
});
