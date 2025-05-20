import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";

export class SandboxNetwork extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }
}

