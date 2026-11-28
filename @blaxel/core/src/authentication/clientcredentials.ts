import { jwtDecode } from "jwt-decode";
import { oauthToken } from "../client/authentication.js";
import { env } from "../common/env.js";
import { Credentials } from "./credentials.js";
import { CredentialsType } from "./types.js";

// Forced renewals back off by counting rejections, never by time: the local
// clock is the thing that cannot be trusted here. The n-th consecutive forced
// renewal needs 2^(n-1) rejections of the current token, capped at this many.
const MAX_REJECTIONS_PER_FORCED_RENEWAL = 64;

export class ClientCredentials extends Credentials {
  private clientCredentials: string;
  private accessToken: string;
  private credentials: CredentialsType;
  private currentPromise: Promise<void> | null;
  private forceRefresh = false;
  private consecutiveForced = 0;
  private rejectionsSinceForce = 0;

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
    if (this.forceRefresh) return true;
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

  /**
   * Mark the cached token for renewal so the next authenticate() exchanges the
   * client credentials again.
   *
   * needRefresh() trusts the local clock, which a workload cannot always do:
   * an agent suspended while idle resumes with the wall clock it was paused
   * with, so a token that expired during the pause still looks fresh to it.
   * The server's 401 is the one signal that does not depend on that clock.
   *
   * - The token stays readable until it is replaced: callers that read
   *   settings.headers without authenticating keep working meanwhile.
   * - `rejectedToken` is the token the failed request carried. A rejection
   *   that arrives after the token was already replaced is ignored, so a late
   *   401 cannot discard a fresh token.
   * - Consecutive forced renewals back off by rejection count (1, 2, 4, ...
   *   up to MAX_REJECTIONS_PER_FORCED_RENEWAL), so a server that keeps
   *   rejecting cannot turn every request into a token exchange. The count is
   *   not time-based, so a frozen clock cannot hold the backoff shut. A
   *   renewal the clock asked for resets it.
   */
  invalidate(rejectedToken?: string): void {
    if (this.currentPromise) return; // a refresh is already on its way
    if (this.forceRefresh) return; // already due
    if (rejectedToken !== undefined && rejectedToken !== this.accessToken) return;
    this.rejectionsSinceForce++;
    const needed = Math.min(2 ** this.consecutiveForced, MAX_REJECTIONS_PER_FORCED_RENEWAL);
    if (this.rejectionsSinceForce < needed) return;
    this.rejectionsSinceForce = 0;
    this.consecutiveForced++;
    this.forceRefresh = true;
  }

  async authenticate() {
    if (this.currentPromise) {
      return this.currentPromise;
    }
    if (!this.needRefresh()) {
      return Promise.resolve();
    }
    this.currentPromise = this.processWithRetry().finally(() => {
      this.currentPromise = null;
    });
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
    if (!this.forceRefresh) {
      // A renewal the clock asked for: the token lifecycle is healthy again.
      this.consecutiveForced = 0;
      this.rejectionsSinceForce = 0;
    }
    this.forceRefresh = false;
  }

  get authorization() {
    return `Bearer ${this.accessToken}`;
  }

  get token() {
    return this.accessToken;
  }
}
