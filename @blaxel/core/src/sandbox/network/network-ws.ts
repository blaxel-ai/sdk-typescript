import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { WebSocketClient } from "../websocket/index.js";

export class SandboxNetworkWebSocket extends SandboxAction {
  private wsClient: WebSocketClient;

  constructor(sandbox: Sandbox, wsClient: WebSocketClient) {
    super(sandbox);
    this.wsClient = wsClient;
  }
}

