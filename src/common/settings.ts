import { Credentials } from "../authentication/credentials.js";
import authentication from "../authentication/index.js";
class Settings {
  credentials: Credentials;

  constructor() {
    this.credentials = authentication()
  }

  get env() {
    return process.env.BL_ENV || "prod";
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

  get workspace() : string {
    return this.credentials.workspace || '';
  }

  get authorization() {
    return this.credentials.authorization;
  }

  get token() {
    return this.credentials.token;
  }

  get headers() : Record<string, string> {
    return {
      "x-blaxel-authorization": this.authorization,
      "x-blaxel-workspace": this.workspace || "",
    }
  }

  get name() {
    return process.env.BL_NAME || "";
  }

  get runInternalHostname() {
    return process.env.BL_RUN_INTERNAL_HOSTNAME || "internal.run.beamlit.net";
  }

  async authenticate() {
    await this.credentials.authenticate();
  }
}

export default new Settings();