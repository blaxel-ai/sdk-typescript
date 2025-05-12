import { Credentials } from "../authentication/credentials.js";
import { authentication } from "../authentication/index.js";
import { env } from "../common/env.js";
export type Config = {
  proxy?: string;
  apikey?: string;
  workspace?: string;
}
class Settings {
  credentials: Credentials;
  config: Config;
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

  get headers(): Record<string, string> {
    return {
      "x-blaxel-authorization": this.authorization,
      "x-blaxel-workspace": this.workspace || "",
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
