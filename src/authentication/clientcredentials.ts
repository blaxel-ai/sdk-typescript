import { oauthToken } from "../client/authentication.js";
import { Credentials } from "./credentials.js";
import { CredentialsType } from "./types.js";

export class ClientCredentials extends Credentials {
  private clientCredentials: string;
  private accessToken: string;
  private credentials: CredentialsType;

  constructor(credentials: CredentialsType) {
    super();
    this.clientCredentials = credentials.clientCredentials || '';
    this.credentials = credentials
    this.accessToken = ''
  }

  get workspace() {
    return this.credentials.workspace || process.env.BL_WORKSPACE || '';
  }

  async authenticate() {
    await this.refresh()
  }

  async refresh() {
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
  }

  get authorization() {
    return `Bearer ${this.accessToken}`
  }

  get token() {
    return this.accessToken
  }

}