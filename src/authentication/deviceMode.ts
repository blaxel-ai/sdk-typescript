import { oauthToken } from "../client/authentication.js";
import { CredentialsType } from "./types.js";

export class DeviceMode {
  private refreshToken: string;
  private deviceCode: string;
  private accessToken: string;
  private credentials: CredentialsType;
  // private expireIn: number;
  constructor(credentials: CredentialsType) {
    this.refreshToken = credentials.refresh_token || ''
    this.deviceCode = credentials.device_code || ''
    this.accessToken = credentials.access_token || ''
    this.credentials = credentials
    // this.expireIn = credentials.expires_in || 7200
  }

  get workspace() {
    return this.credentials.workspace || process.env.BL_WORKSPACE || '';
  }

  async authenticate() {
    await this.refresh()
  }

  async refresh() {
    // TODO: Implement expire usage, to avoid calling the API every time we refresh the token
    const response = await oauthToken({
      body: {
        grant_type: 'refresh_token',
        device_code: this.deviceCode,
        refresh_token: this.refreshToken
      }
    })
    if(response.error) {
      throw new Error(response.error.error)
    }
    this.accessToken = response.data?.access_token || ''
    // this.expireIn = response.data?.expires_in || 7200
  }

  get authorization() {
      return `Bearer ${this.accessToken}`
  }

  get token() {
    return this.accessToken
  }
}
