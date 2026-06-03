import yaml from 'yaml';
import { ApiKey } from "../authentication/apikey.js";
import { ClientCredentials } from "../authentication/clientcredentials.js";
import { Credentials, MissingCredentials } from "../authentication/credentials.js";
import { authentication } from "../authentication/index.js";
import { env } from "../common/env.js";
import { CredentialsError } from "../common/errors.js";
import { fs, os, path } from "../common/node.js";

/**
 * Build an actionable "credentials missing" message naming exactly which piece
 * is absent, based on the env vars currently set.
 */
function missingCredentialsMessage(): string {
  const hasWorkspace = !!env.BL_WORKSPACE;
  const hasApiKey = !!env.BL_API_KEY;
  if (hasWorkspace && !hasApiKey) {
    return "Blaxel API key is missing. Set the BL_API_KEY environment variable, or run `bl login`, to authenticate (BL_WORKSPACE is already set).";
  }
  if (hasApiKey && !hasWorkspace) {
    return "Blaxel workspace is missing. Set the BL_WORKSPACE environment variable, or run `bl login`, to authenticate (BL_API_KEY is already set).";
  }
  return "No Blaxel credentials found. Set the BL_API_KEY and BL_WORKSPACE environment variables, or run `bl login`.";
}

/**
 * Client credentials as a `{ clientId, clientSecret }` pair.
 * The SDK will Base64-encode them automatically.
 */
export type ClientCredentialsPair = {
  clientId: string;
  clientSecret: string;
}

export type Config = {
  proxy?: string;
  apikey?: string;
  workspace?: string;
  disableH2?: boolean;
  /**
   * Maximum number of concurrent in-flight HTTP/2 requests across the shared
   * H2 session pool. `0` or `undefined` means unlimited (current behavior).
   */
  maxConcurrentH2Requests?: number;
  /**
   * Maximum number of concurrent in-flight multipart upload-part requests per
   * edge domain on the shared H2 connection. Defaults to 2 (the measured value
   * that stops concurrent large uploads tripping ENHANCE_YOUR_CALM). Scoped to
   * the upload-part path only; non-upload traffic is unaffected. `0` disables it.
   */
  maxConcurrentUploadH2Requests?: number;
  /**
   * Retry attempts for transient connection resets (ECONNRESET, GOAWAY,
   * ENHANCE_YOUR_CALM, etc.) on file uploads. Covers both small single-PUT
   * uploads and multipart parts; both are idempotent writes and safe to retry.
   * Defaults to 3. Set `0` to disable.
   */
  fsPartRetries?: number;
  /**
   * Retry attempts for transient connection resets on IDEMPOTENT sandbox reads
   * (fs.read/readBinary/ls/search/find/grep, drives.list, process.get/list/logs).
   * Higher than the upload default so a later attempt can span a multi-second
   * sandbox cold-start/standby wake (the window a first-call read reset falls in).
   * Defaults to 5. Set `0` to disable. Never applied to non-idempotent ops
   * (process.exec, drives.mount, etc.).
   */
  sandboxReadRetries?: number;
  /**
   * Client credentials for OAuth2 client_credentials flow.
   *
   * Accepts either:
   * - A pre-encoded Base64 string (`btoa("clientId:clientSecret")`)
   * - An object `{ clientId, clientSecret }` (the SDK encodes it for you)
   */
  clientCredentials?: string | ClientCredentialsPair;
  /** API key for bearer token authentication */
  apiKey?: string;
}

// Build info - these placeholders are replaced at build time by build:replace-imports
const BUILD_VERSION = "__BUILD_VERSION__";
const BUILD_COMMIT = "__BUILD_COMMIT__";
const BUILD_SENTRY_DSN = "__BUILD_SENTRY_DSN__";
const BLAXEL_API_VERSION = "2026-04-16";

// Cache for config.yaml tracking value
let configTrackingValue: boolean | null = null;
let configTrackingLoaded = false;

function getConfigTracking(): boolean | null {
  if (configTrackingLoaded) {
    return configTrackingValue;
  }
  configTrackingLoaded = true;

  if (os === null || fs === null || path === null) {
    return null;
  }

  try {
    const homeDir = os.homedir();
    const config = fs.readFileSync(
      path.join(homeDir, ".blaxel/config.yaml"),
      "utf8"
    );
    type ConfigWithTracking = {
      tracking?: boolean;
    };
    const configJson = yaml.parse(config) as ConfigWithTracking;
    if (typeof configJson.tracking === 'boolean') {
      configTrackingValue = configJson.tracking;
      return configTrackingValue;
    }
  } catch {
    // If any error, return null
  }
  return null;
}

// Function to get OS and architecture
function getOsArch(): string {
  try {
    // Node.js environment
    if (typeof process !== 'undefined' && process.platform && process.arch) {
      const platform = process.platform === 'win32' ? 'windows' :
                      process.platform === 'darwin' ? 'darwin' :
                      process.platform === 'linux' ? 'linux' : process.platform;
      return `${platform}/${process.arch}`;
    }
  } catch {
    // Fall through to browser detection
  }

  // Browser environment - use fixed detection
  try {
    type NavigatorLike = { platform?: unknown };
    type GlobalLike = typeof globalThis & { navigator?: NavigatorLike };
    const g = globalThis as GlobalLike;
    const platformValue = g.navigator?.platform;
    if (typeof platformValue === 'string') {
      const navPlatform = platformValue.toLowerCase();
      const platform = navPlatform.includes('win') ? 'windows' :
                      navPlatform.includes('mac') ? 'darwin' :
                      navPlatform.includes('linux') ? 'linux' : 'browser';
      const arch = navPlatform.includes('64') ? 'amd64' : 'unknown';
      return `${platform}/${arch}`;
    }
  } catch {
    // Ignore errors
  }

  return "browser/unknown";
}

function isDenoRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & { Deno?: unknown };
  return typeof runtime.Deno !== "undefined";
}

class Settings {
  private _credentials: Credentials | null;
  config: Config;

  constructor() {
    // `credentials` are resolved lazily on first access so that simply
    // importing `@blaxel/core` does not read `~/.blaxel/config.yaml`
    // or mutate `process.env.BL_ENV`. See the `credentials` getter.
    this._credentials = null;
    this.config = {
      proxy: "",
      apikey: "",
      workspace: "",
    };
  }

  get credentials(): Credentials {
    if (this._credentials === null) {
      this._credentials = authentication();
    }
    return this._credentials;
  }

  set credentials(value: Credentials | null) {
    this._credentials = value;
  }

  setConfig(config: Config) {
    this.config = config;
    if (config.apiKey) {
      this._credentials = new ApiKey({
        apiKey: config.apiKey,
        workspace: config.workspace,
      });
    } else if (config.clientCredentials) {
      const encoded = typeof config.clientCredentials === 'string'
        ? config.clientCredentials
        : btoa(`${config.clientCredentials.clientId}:${config.clientCredentials.clientSecret}`);
      this._credentials = new ClientCredentials({
        clientCredentials: encoded,
        workspace: config.workspace,
      });
    }
  }

  get env() {
    return env.BL_ENV || "prod";
  }

  get baseUrl() {
    if(this.config.proxy) {
      return this.config.proxy+"/api";
    }
    if(env.BL_API_URL) {
      return env.BL_API_URL;
    }
    if (this.env === "prod") {
      return "https://api.blaxel.ai/v0";
    }
    return "https://api.blaxel.dev/v0";
  }

  get runUrl() {
    if(this.config.proxy) {
      return this.config.proxy+"/run";
    }
    if(env.BL_RUN_URL) {
      return env.BL_RUN_URL;
    }
    if (this.env === "prod") {
      return "https://run.blaxel.ai";
    }
    return "https://run.blaxel.dev";
  }

  get workspace(): string {
    return this.config.workspace || this.credentials.workspace || "";
  }

  get authorization(): string {
    if(this.config.apikey) {
      return 'Bearer '+this.token;
    }
    return this.credentials.authorization;
  }

  get token(): string {
    if(this.config.apikey) {
      return this.config.apikey;
    }
    return this.credentials.token;
  }

  get version(): string {
    return BUILD_VERSION || "unknown";
  }

  get commit(): string {
    const commit = BUILD_COMMIT || "unknown";
    return commit.length > 7 ? commit.substring(0, 7) : commit;
  }

  get sentryDsn(): string {
    return BUILD_SENTRY_DSN || "";
  }

  get apiVersion(): string {
    return env.BL_API_VERSION || BLAXEL_API_VERSION;
  }

  get headers(): Record<string, string> {
    this.assertCredentials();
    const osArch = getOsArch();
    return {
      "x-blaxel-authorization": this.authorization,
      "x-blaxel-workspace": this.workspace || "",
      "Blaxel-Version": this.apiVersion,
      "User-Agent": `blaxel/sdk/typescript/${this.version} (${osArch}) blaxel/${this.commit}`,
    };
  }

  get name() {
    return env.BL_NAME || "";
  }

  get type() {
    return env.BL_TYPE || "agents";
  }

  get runInternalHostname() {
    if(!this.generation) {
      return ""
    }
    return env.BL_RUN_INTERNAL_HOST || "";
  }

  get runInternalProtocol() {
    return env.BL_RUN_INTERNAL_PROTOCOL || "https";
  }

  get blCloud() {
    return env.BL_CLOUD === "true";
  }

  get generation() {
    return env.BL_GENERATION || "";
  }

  get loggerType() {
    return env.BL_LOGGER || "http";
  }

  get tracking(): boolean {
    // Environment variable has highest priority
    if (env.DO_NOT_TRACK !== undefined) {
      // DO_NOT_TRACK has inverted semantics: true means tracking disabled
      return env.DO_NOT_TRACK !== "true" && env.DO_NOT_TRACK !== "1";
    }
    // Then check config.yaml
    const configValue = getConfigTracking();
    if (configValue !== null) {
      return configValue;
    }
    // Default to false (opt-in tracking)
    return false;
  }

  get region() {
    return env.BL_REGION || undefined;
  }

  get disableH2(): boolean {
    if (typeof this.config.disableH2 === "boolean") {
      return this.config.disableH2;
    }
    const value = env.BL_DISABLE_H2;
    if (value) {
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    }
    return isDenoRuntime();
  }

  get maxConcurrentH2Requests(): number {
    if (typeof this.config.maxConcurrentH2Requests === "number") {
      return this.config.maxConcurrentH2Requests;
    }
    const value = env.BL_MAX_H2_INFLIGHT;
    if (value) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return 0;
  }

  get maxConcurrentUploadH2Requests(): number {
    if (typeof this.config.maxConcurrentUploadH2Requests === "number") {
      return this.config.maxConcurrentUploadH2Requests;
    }
    const value = env.BL_MAX_UPLOAD_H2_INFLIGHT;
    if (value) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return 2;
  }

  get fsPartRetries(): number {
    if (typeof this.config.fsPartRetries === "number") {
      return this.config.fsPartRetries;
    }
    const value = env.BL_FS_PART_RETRIES;
    if (value) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return 3;
  }

  get sandboxReadRetries(): number {
    if (typeof this.config.sandboxReadRetries === "number") {
      return this.config.sandboxReadRetries;
    }
    const value = env.BL_SANDBOX_READ_RETRIES;
    if (value) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return 5;
  }

  /**
   * Fail fast with a clear, actionable error when credentials are missing or
   * incomplete, instead of sending empty workspace/authorization headers and
   * surfacing a misleading server-side "workspace is required". Skipped for
   * `forceUrl` sandbox sessions, which carry their own headers and never read
   * `settings.headers`. Leaves `workspace` itself non-throwing so telemetry
   * tagging stays safe.
   */
  private assertCredentials() {
    const hasConfigCredentials = !!(
      this.config.apikey ||
      this.config.apiKey ||
      this.config.clientCredentials
    );
    if (!hasConfigCredentials && this.credentials instanceof MissingCredentials) {
      throw new CredentialsError(missingCredentialsMessage());
    }
    if (!this.workspace) {
      throw new CredentialsError(
        "Blaxel workspace is missing. Set the BL_WORKSPACE environment variable, or run `bl login`, to authenticate your requests."
      );
    }
  }

  async authenticate() {
    this.assertCredentials();
    await this.credentials.authenticate();
  }
}

export const settings = new Settings();
