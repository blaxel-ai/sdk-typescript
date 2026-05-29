import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiKey } from '../authentication/apikey.js';
import { Credentials, MissingCredentials } from '../authentication/credentials.js';
import { authentication } from '../authentication/index.js';
import { CredentialsError } from './errors.js';
import { settings } from './settings.js';

/**
 * ENG-2698: missing / partial BL_WORKSPACE / BL_API_KEY must fail fast with a
 * clear, actionable error instead of silently sending empty headers and
 * surfacing the server's misleading "workspace is required".
 *
 * `env` reads through to `process.env`, so env state is controlled there.
 */
describe('credential validation', () => {
  const AUTH_ENV = ['BL_API_KEY', 'BL_WORKSPACE', 'BL_CLIENT_CREDENTIALS'] as const;
  let savedEnv: Record<string, string | undefined>;
  let savedCredentials: Credentials;
  let savedConfig: typeof settings.config;

  beforeEach(() => {
    savedEnv = {};
    for (const key of AUTH_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedCredentials = settings.credentials;
    savedConfig = settings.config;
    settings.config = { proxy: '', apikey: '', workspace: '' };
  });

  afterEach(() => {
    for (const key of AUTH_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    settings.credentials = savedCredentials;
    settings.config = savedConfig;
  });

  it('API key without workspace throws a clear BL_WORKSPACE error from headers', () => {
    settings.credentials = new ApiKey({ apiKey: 'test-key' });
    expect(() => settings.headers).toThrow(CredentialsError);
    expect(() => settings.headers).toThrow(/BL_WORKSPACE/);
  });

  it('API key without workspace rejects from authenticate()', async () => {
    settings.credentials = new ApiKey({ apiKey: 'test-key' });
    await expect(settings.authenticate()).rejects.toThrow(/BL_WORKSPACE/);
  });

  it('workspace set but no API key names the missing API key', () => {
    process.env.BL_WORKSPACE = 'my-workspace';
    settings.credentials = new MissingCredentials();
    expect(() => settings.headers).toThrow(/API key is missing/);
  });

  it('no credentials at all names both env vars', () => {
    settings.credentials = new MissingCredentials();
    expect(() => settings.headers).toThrow(CredentialsError);
    expect(() => settings.headers).toThrow(/BL_API_KEY and BL_WORKSPACE/);
  });

  it('api key + workspace builds clean headers with no empty values', () => {
    settings.credentials = new ApiKey({ apiKey: 'test-key', workspace: 'my-workspace' });
    const headers = settings.headers;
    expect(headers['x-blaxel-workspace']).toBe('my-workspace');
    expect(headers['x-blaxel-authorization']).toBe('Bearer test-key');
    expect(Object.values(headers)).not.toContain('');
  });

  it('authentication() returns a real ApiKey when BL_API_KEY is set', () => {
    process.env.BL_API_KEY = 'test-key';
    expect(authentication()).toBeInstanceOf(ApiKey);
  });
});
