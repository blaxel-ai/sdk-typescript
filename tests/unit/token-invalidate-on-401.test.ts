import { settings } from "@blaxel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientCredentials } from "../../@blaxel/core/src/authentication/clientcredentials.js";
import { invalidateOnUnauthorized } from "../../@blaxel/telemetry/src/auth_refresh_exporters.js";

type Testable = { accessToken: string; currentPromise: Promise<void> | null };

// A token whose exp is far in the future by the local clock. A workload
// resumed from a pause sees exactly this: the token expired on the server
// while the guest clock stood still, so it still looks fresh locally.
function freshLookingJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 7200, sub: "t" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function credentials(): ClientCredentials {
  return new ClientCredentials({ clientCredentials: "dGVzdDp0ZXN0", workspace: "test" });
}

describe("ClientCredentials.invalidate", () => {
  // Proves a token the local clock calls fresh is renewed once the server rejected it.
  it("forces a refresh of a token the local clock still considers fresh", () => {
    const creds = credentials();
    const token = freshLookingJwt();
    (creds as unknown as Testable).accessToken = token;
    expect(creds.needRefresh()).toBe(false);

    creds.invalidate(token);

    expect(creds.needRefresh()).toBe(true);
  });

  // Proves callers that read the token without authenticating keep a usable value meanwhile.
  it("keeps the token readable until it is replaced", () => {
    const creds = credentials();
    const token = freshLookingJwt();
    (creds as unknown as Testable).accessToken = token;

    creds.invalidate(token);

    expect(creds.token).toBe(token);
  });

  // Proves a late 401 for a token that was already replaced leaves the new token alone.
  it("ignores a rejection of a token that was already replaced", () => {
    const creds = credentials();
    (creds as unknown as Testable).accessToken = freshLookingJwt();

    creds.invalidate("an-older-token");

    expect(creds.needRefresh()).toBe(false);
  });

  // Proves a server that keeps rejecting cannot turn every export into a token
  // exchange. The backoff counts rejections and reads no clock, so the second
  // renewal below happens with no time passing at all: a clock frozen by a
  // pause cannot hold it shut.
  it("backs off consecutive forced renewals by rejection count, not time", () => {
    const creds = credentials();
    const testable = creds as unknown as Testable & { forceRefresh: boolean };
    let token = freshLookingJwt();
    testable.accessToken = token;

    creds.invalidate(token); // first rejection renews at once
    expect(creds.needRefresh()).toBe(true);

    // As if the forced renewal completed and fetched a new token.
    testable.forceRefresh = false;
    token = `${freshLookingJwt()}x`;
    testable.accessToken = token;

    creds.invalidate(token); // second episode: 1 of 2 rejections needed
    expect(creds.needRefresh()).toBe(false);
    creds.invalidate(token); // 2 of 2, renews although the clock never moved
    expect(creds.needRefresh()).toBe(true);
  });

  // Proves invalidate does not interfere with a refresh already in flight.
  it("leaves an in-flight refresh alone", () => {
    const creds = credentials();
    const testable = creds as unknown as Testable & { forceRefresh: boolean };
    const token = freshLookingJwt();
    testable.accessToken = token;
    testable.currentPromise = new Promise(() => {});

    creds.invalidate(token);

    expect(testable.forceRefresh).toBe(false);
  });
});

describe("telemetry exporters on 401", () => {
  afterEach(() => vi.restoreAllMocks());

  function otlpError(code: number): Error {
    return Object.assign(new Error("Unauthorized"), { name: "OTLPExporterError", code });
  }

  // Proves a 401 from the collector renews the token it rejected and still reports the failure.
  it("invalidates the credentials when the collector answers 401", () => {
    const invalidate = vi.spyOn(settings, "invalidateCredentials").mockImplementation(() => {});
    const callback = vi.fn();
    const result = { code: 1, error: otlpError(401) };

    invalidateOnUnauthorized(callback, "test", "sent-token")(result);

    expect(invalidate).toHaveBeenCalledExactlyOnceWith("sent-token");
    expect(callback).toHaveBeenCalledWith(result);
  });

  // Proves other failures and successes keep the token: only a rejected token is dropped.
  it("keeps the credentials on success and on non-401 failures", () => {
    const invalidate = vi.spyOn(settings, "invalidateCredentials").mockImplementation(() => {});
    const wrapped = invalidateOnUnauthorized(vi.fn(), "test", "sent-token");

    wrapped({ code: 0 });
    wrapped({ code: 1, error: otlpError(500) });
    wrapped({ code: 1, error: new Error("Request Timeout") });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
