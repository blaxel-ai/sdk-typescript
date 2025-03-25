import { jwtDecode } from 'jwt-decode';
import { oauthToken } from "../client/authentication.js";
import { CredentialsType } from "./types.js";
export class DeviceMode {
  private refreshToken: string;
  private deviceCode: string;
  private accessToken: string;
  private credentials: CredentialsType;
  private currentPromise: Promise<void> | null;
  // private expireIn: number;
  constructor(credentials: CredentialsType) {
    this.refreshToken = credentials.refresh_token || ''
    this.deviceCode = credentials.device_code || ''
    this.accessToken = credentials.access_token || ''
    this.credentials = credentials
    this.currentPromise = null
  }

  get workspace() {
    return this.credentials.workspace || process.env.BL_WORKSPACE || '';
  }

  needRefresh() {
    if (this.currentPromise) return false
    if (this.accessToken) {
      const decoded = jwtDecode(this.accessToken)
      const {exp,iat} = decoded
      if (!exp || !iat) return true
      const expDate = new Date(exp * 1000)
      const iatDate = new Date(iat * 1000)
      const nowDate = new Date()
      const diff = expDate.getTime() - nowDate.getTime()
      const iatDiff = expDate.getTime() - iatDate.getTime()
      const ratio = diff/iatDiff
      return ratio < 0.5
    }
    return true
  }

  async authenticate() {
    if (!this.needRefresh()) {
      return this.currentPromise || Promise.resolve()
    }
    this.currentPromise = this.process()
    return this.currentPromise
  }

  async process() {
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
    this.currentPromise = null
  }

  get authorization() {
    return `Bearer ${this.accessToken}`
  }

  get token() {
    return this.accessToken
  }
}
