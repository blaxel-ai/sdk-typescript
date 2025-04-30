import { env } from "process";
import { UVM } from "../client";
import settings from "../common/settings";

export class UVMAction {
  constructor(private uvm: UVM) {}
  get externalUrl() {
    return new URL(
      `${settings.runUrl}/${settings.workspace}/uvm/${this.uvm.metadata?.name}`
    );
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get url() {
    const envVar = this.uvm.metadata?.name?.replace(/-/g, "_").toUpperCase();
    if (env[`BL_UVM_${envVar}_SERVICE_NAME`]) {
      return new URL(
        `https://${env[`BL_UVM_${envVar}_SERVICE_NAME`]}.${
          settings.runInternalHostname
        }`
      );
    }
    return this.externalUrl;
  }
}