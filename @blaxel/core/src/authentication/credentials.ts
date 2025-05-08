import { env } from "../common/env.js";

export class Credentials {
  async authenticate() {}

  get workspace() {
    return env.BL_WORKSPACE || "";
  }

  get authorization() {
    return "";
  }

  get token() {
    return "";
  }
}
