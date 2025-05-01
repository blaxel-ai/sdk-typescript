import { env } from "process";
import { Sandbox } from "../client";
import { getGlobalUniqueHash } from "../common/internal";
import settings from "../common/settings";

export class SandboxAction {
  constructor(private sandbox: Sandbox) {}

  get name() {
    return this.sandbox.metadata?.name ?? "";
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    return `${settings.runUrl}/${settings.workspace}/sandboxes/${this.name}`
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(settings.workspace, "sandbox", this.name);
    return `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`
  }

  get forcedUrl() {
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    const envName = `BL_SANDBOX_${envVar}_URL`
    if (env[envName]) {
      return env[envName]
    }
    return null;
  }

  get url(): string {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }
}