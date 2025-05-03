import { Sandbox } from "../client";
import { SandboxAction } from "./action";

export class SandboxNetwork extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }
}

