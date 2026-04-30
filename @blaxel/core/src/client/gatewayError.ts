/**
 * Error thrown when the Blaxel gateway proxy synthesizes an error response.
 *
 * The gateway sets the `X-Blaxel-Source: platform` header on every response it
 * generates itself (as opposed to forwarding from the upstream workload). This
 * class exposes the stable error code and agent-readable metadata so callers
 * can branch on {@link errorCode} instead of parsing free-text messages.
 */
export class GatewayError extends Error {
  /** Stable error code from the `X-Blaxel-Error-Code` header. */
  readonly errorCode: string;
  /** HTTP status code of the gateway response. */
  readonly statusCode: number;
  /** Whether retrying the same request may succeed. */
  readonly retryable: boolean;
  /** Directive telling the caller what to do next. */
  readonly action: string;
  /** Anti-pattern warning (may be undefined). */
  readonly doNot?: string;
  /** Link to the relevant documentation page (may be undefined). */
  readonly docsUrl?: string;
  /** The raw gateway response. */
  readonly response: Response;

  constructor(opts: {
    errorCode: string;
    message: string;
    statusCode: number;
    retryable: boolean;
    action: string;
    doNot?: string;
    docsUrl?: string;
    response: Response;
  }) {
    super(opts.message);
    this.name = "GatewayError";
    this.errorCode = opts.errorCode;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable;
    this.action = opts.action;
    this.doNot = opts.doNot;
    this.docsUrl = opts.docsUrl;
    this.response = opts.response;
  }
}
