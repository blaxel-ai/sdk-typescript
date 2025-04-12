import { Credentials } from "../authentication/credentials.js";
import authentication from "../authentication/index.js";
import { env } from "../common/env.js";
class Settings {
  credentials: Credentials;

  constructor() {
    this.credentials = authentication();
  }

  get env() {
    return env.BL_ENV || "prod";
  }

  get baseUrl() {
    if (this.env === "prod") {
      return "https://api.blaxel.ai/v0";
    }
    return "https://api.blaxel.dev/v0";
  }

  get runUrl() {
    if (this.env === "prod") {
      return "https://run.blaxel.ai";
    }
    return "https://run.blaxel.dev";
  }

  get workspace(): string {
    return this.credentials.workspace || "";
  }

  get authorization(): string {
    return this.credentials.authorization;
  }

  get token(): string {
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
    return env.BL_RUN_INTERNAL_HOSTNAME || "internal.run.beamlit.net";
  }

  async authenticate() {
    await this.credentials.authenticate();
  }
}

export default new Settings();
