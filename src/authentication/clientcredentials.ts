import { jwtDecode } from "jwt-decode";
import { oauthToken } from "../client/authentication.js";
import { Credentials } from "./credentials.js";
import { CredentialsType } from "./types.js";

export class ClientCredentials extends Credentials {
  private clientCredentials: string;
  private accessToken: string;
  private credentials: CredentialsType;
  private currentPromise: Promise<void> | null;

  constructor(credentials: CredentialsType) {
    super();
    this.clientCredentials = credentials.clientCredentials || '';
    this.credentials = credentials
    this.accessToken = ''
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
      headers: {
        'Authorization': `Basic ${this.clientCredentials}`
      },
      body: {
        grant_type: 'client_credentials'
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