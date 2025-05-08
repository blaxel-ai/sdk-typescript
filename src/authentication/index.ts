import { env } from "../common/env.js";
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
  return null;
}

export default function authentication() {
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
