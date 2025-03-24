import fs from 'fs';
import os from 'os';
import { join } from 'path';
import yaml from 'yaml';
import { ApiKey } from "./apikey.js";
import { ClientCredentials } from "./clientcredentials.js";
import { Credentials } from "./credentials.js";
import { DeviceMode } from './deviceMode.js';
import { CredentialsType } from './types.js';


function getCredentials(): CredentialsType | null {
  if(process.env.BL_API_KEY) {
    return {
      apiKey: process.env.BL_API_KEY,
      workspace: process.env.BL_WORKSPACE
    }
  }
  if(process.env.BL_CLIENT_CREDENTIALS) {
    return {
      clientCredentials: process.env.BL_CLIENT_CREDENTIALS,
      workspace: process.env.BL_WORKSPACE
    }
  }
  try {
    const homeDir = os.homedir();
    const config = fs.readFileSync(join(homeDir, '.blaxel/config.yaml'), 'utf8')
    const configJson = yaml.parse(config)
    const workspaceName = process.env.BL_WORKSPACE || configJson.context.workspace
    const credentials = configJson.workspaces.find((wk: any) => wk.name === workspaceName)?.credentials
    credentials.workspace = workspaceName
    return credentials
  } catch {
    return null
  }
}

export default function authentication() {
  const credentials = getCredentials()
  if (!credentials) {
    return new Credentials();
  }

  if(credentials.apiKey) {
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