
import yaml from 'yaml';
import { env } from "../common/env.js";
import { fs, os, path } from "../common/node.js";
import { ApiKey } from "./apikey.js";
import { ClientCredentials } from "./clientcredentials.js";
import { Credentials } from "./credentials.js";
import { DeviceMode } from "./deviceMode.js";
import { CredentialsType } from "./types.js";

function getCredentials(): CredentialsType | null {
  if (env.BL_API_KEY) {
    return {
      apiKey: env.BL_API_KEY,
      workspace: env.BL_WORKSPACE,
    };
  }
  if (env.BL_CLIENT_CREDENTIALS) {
    return {
      clientCredentials: env.BL_CLIENT_CREDENTIALS,
      workspace: env.BL_WORKSPACE,
    };
  }

  if (os === null || fs === null || path === null) {
    return null;
  }
  try {
    const homeDir = os.homedir();
    const config = fs.readFileSync(
      path.join(homeDir, ".blaxel/config.yaml"),
      "utf8"
    );
    type AuthWorkspace = {
      name: string;
      env?: string;
      credentials: CredentialsType;
    };
    type AuthConfig = {
      context: {
        workspace: string;
      };
      workspaces: AuthWorkspace[];
    };

    const configJson = yaml.parse(config) as AuthConfig;
    const workspaceName = env.BL_WORKSPACE || configJson.context.workspace;
    const workspace = configJson.workspaces.find(
      (wk: AuthWorkspace) => wk.name === workspaceName
    );

    // Set BL_ENV from config.yaml workspace if not already set via env vars
    if (!env.BL_ENV && workspace?.env) {
      process.env.BL_ENV = workspace.env;
    }

    if (!workspace?.credentials) {
      return null;
    }

    workspace.credentials.workspace = workspaceName;
    return workspace.credentials;
  } catch {
    // If any error (e.g., running in browser), just return null
    return null;
  }
}

export function authentication() {
  const credentials = getCredentials();
  if (!credentials) {
    return new Credentials();
  }

  if (credentials.apiKey) {
    return new ApiKey(credentials);
  }
  if (credentials.clientCredentials) {
    return new ClientCredentials(credentials);
  }
  if (credentials.device_code) {
    return new DeviceMode(credentials);
  }
  return new Credentials();
}
