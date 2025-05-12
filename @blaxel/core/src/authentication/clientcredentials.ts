import { jwtDecode } from "jwt-decode";
import { oauthToken } from "../client/authentication.js";
import { env } from "../common/env.js";
import { Credentials } from "./credentials.js";
import { CredentialsType } from "./types.js";

export class ClientCredentials extends Credentials {
  private clientCredentials: string;
  private accessToken: string;
  private credentials: CredentialsType;
  private currentPromise: Promise<void> | null;

  constructor(credentials: CredentialsType) {
    super();
    this.clientCredentials = credentials.clientCredentials || "";
    this.credentials = credentials;
    this.accessToken = "";
    this.currentPromise = null;
  }

  get workspace() {
    return this.credentials.workspace || env.BL_WORKSPACE || "";
  }

  needRefresh() {
    if (this.currentPromise) return false;
    if (this.accessToken) {
      const decoded = jwtDecode(this.accessToken);
      const { exp, iat } = decoded;
      if (!exp || !iat) return true;
      const expDate = new Date(exp * 1000);
      const iatDate = new Date(iat * 1000);
      const nowDate = new Date();
      const diff = expDate.getTime() - nowDate.getTime();
      const iatDiff = expDate.getTime() - iatDate.getTime();
      const ratio = diff / iatDiff;
      return ratio < 0.5;
    }
    return true;
  }

  async authenticate() {
    if (!this.needRefresh()) {
      return this.currentPromise || Promise.resolve();
    }
    this.currentPromise = this.processWithRetry();
    return this.currentPromise;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async processWithRetry(retry=3): Promise<void> {
    try {
      return await this.process();
    } catch (error) {
      if (retry > 0) {
        await this.sleep(1000);
        return this.processWithRetry(retry - 1);
      }
      throw error;
    }
  }

  async process(): Promise<void> {
    const response = await oauthToken({
      headers: {
        Authorization: `Basic ${this.clientCredentials}`,
      },
      body: {
        grant_type: "client_credentials",
      },
    });
    if (response.error) {
      throw new Error(response.error.error);
    }
    this.accessToken = response.data?.access_token || "";
    this.currentPromise = null;
  }

  get authorization() {
    return `Bearer ${this.accessToken}`;
  }

  get token() {
    return this.accessToken;
  }
}
