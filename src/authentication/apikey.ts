import { Credentials } from "./credentials.js";
import { CredentialsType } from "./types.js";

export class ApiKey extends Credentials {
  private apiKey: string;
  private credentials: CredentialsType;

  constructor(credentials: CredentialsType) {
    super();
    this.apiKey = credentials.apiKey || ''
    this.credentials = credentials
  }

  get workspace() {
    return this.credentials.workspace || process.env.BL_WORKSPACE || '';
  }

  get authorization() {
    return `Bearer ${this.apiKey}`
  }

  get token() {
    return this.apiKey
  }
}
