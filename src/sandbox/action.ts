import { env } from "process";
import { Sandbox } from "../client";
import settings from "../common/settings";

export class SandboxAction {
  constructor(private sandbox: Sandbox) {}
  get externalUrl() {
    return `${settings.runUrl}/${settings.workspace}/sandbox/${this.sandbox.metadata?.name}`;
  }

  get fallbackUrl() {
    if (this.externalUrl !== this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get url() {
    const envVar = this.sandbox.metadata?.name?.replace(/-/g, "_").toUpperCase();
    const forceUrl = env[`BL_Sandbox_${envVar}_URL`];
    if (forceUrl) {
      return forceUrl;
    }
    if (env[`BL_Sandbox_${envVar}_SERVICE_NAME`]) {
      return `https://${env[`BL_Sandbox_${envVar}_SERVICE_NAME`]}.${settings.runInternalHostname}`;
    }
    return this.externalUrl;
  }
}