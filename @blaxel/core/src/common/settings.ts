import { Credentials } from "../authentication/credentials.js";
import { authentication } from "../authentication/index.js";
import { env } from "../common/env.js";
import { PACKAGE_COMMIT, PACKAGE_VERSION } from "./version.js";

export type Config = {
  proxy?: string;
  apikey?: string;
  workspace?: string;
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


class Settings {
  credentials: Credentials;
  config: Config;
  private _version: string | null = null;

  constructor() {
    this.credentials = authentication();
    this.config = {
      proxy: "",
      apikey: "",
      workspace: "",
    };
  }

  setConfig(config: Config) {
    this.config = config;
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
    if (this._version === null) {
      this._version = PACKAGE_VERSION;
    }
    return this._version;
  }

  get headers(): Record<string, string> {
    const osArch = getOsArch();
    const commitHash = PACKAGE_COMMIT.length > 7 ? PACKAGE_COMMIT.substring(0, 7) : PACKAGE_COMMIT;
    return {
      "x-blaxel-authorization": this.authorization,
      "x-blaxel-workspace": this.workspace || "",
      "User-Agent": `blaxel/sdk/typescript/${this.version} (${osArch}) blaxel/${commitHash}`,
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

  async authenticate() {
    await this.credentials.authenticate();
  }
}

export const settings = new Settings();
