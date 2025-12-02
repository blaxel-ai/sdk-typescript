import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook signature verification for async-sidecar callbacks
 */

export interface WebhookVerificationOptions {
  /**
   * The raw request body as a string
   */
  body: string;

  /**
   * The X-Blaxel-Signature header value (format: "sha256=<hex_digest>")
   */
  signature: string;

  /**
   * The secret key used to sign the webhook (same as CALLBACK_SECRET in async-sidecar)
   */
  secret: string;

  /**
   * Optional: The X-Blaxel-Timestamp header value for replay attack prevention
   */
  timestamp?: string;

  /**
   * Optional: Maximum age of the webhook in seconds (default: 300 = 5 minutes)
   */
  maxAge?: number;
}

export interface AsyncSidecarCallback {
  status_code: number;
  response_body: string;
  response_length: number;
  timestamp: number;
}

/**
 * Verify the HMAC-SHA256 signature of a webhook callback from async-sidecar
 *
 * @example
 * ```typescript
 * import { verifyWebhookSignature } from '@blaxel/core';
 *
 * // In your Express endpoint
 * app.post('/webhook', express.text({ type: 'application/json' }), (req, res) => {
 *   const isValid = verifyWebhookSignature({
 *     body: req.body,
 *     signature: req.headers['x-blaxel-signature'] as string,
 *     secret: process.env.CALLBACK_SECRET!
 *   });
 *
 *   if (!isValid) {
 *     return res.status(401).json({ error: 'Invalid signature' });
 *   }
 *
 *   const data = JSON.parse(req.body);
 *   // Process callback...
 * });
 * ```
 *
 * @param options - Verification options
 * @returns true if the signature is valid, false otherwise
 */
export function verifyWebhookSignature(options: WebhookVerificationOptions): boolean {
  const { body, signature, secret, timestamp, maxAge = 300 } = options;

  if (!body || !signature || !secret) {
    return false;
  }

  try {
    // Verify timestamp if provided (prevents replay attacks)
    if (timestamp) {
      const requestTime = parseInt(timestamp, 10);
      const currentTime = Math.floor(Date.now() / 1000);
      const age = Math.abs(currentTime - requestTime);

      if (isNaN(requestTime) || age > maxAge) {
        return false;
      }
    }

    // Extract hex signature from "sha256=<hex>" format
    const expectedSignature = signature.replace('sha256=', '');

    // Compute HMAC-SHA256 signature
    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    const computedSignature = hmac.digest('hex');

    // Timing-safe comparison to prevent timing attacks
    return timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(computedSignature, 'hex')
    );
  } catch {
    // Invalid signature format or other error
    return false;
  }
}

/**
 * Helper to verify webhook from Express request object
 *
 * @example
 * ```typescript
 * import { verifyWebhookFromRequest } from '@blaxel/core';
 * import express from 'express';
 *
 * app.use(express.text({ type: 'application/json' }));
 *
 * app.post('/webhook', (req, res) => {
 *   if (!verifyWebhookFromRequest(req, process.env.CALLBACK_SECRET!)) {
 *     return res.status(401).json({ error: 'Invalid signature' });
 *   }
 *
 *   const data = JSON.parse(req.body);
 *   console.log('Received callback:', data);
 *   res.json({ received: true });
 * });
 * ```
 *
 * @param request - Express request object (must use express.text() middleware)
 * @param secret - The callback secret
 * @param maxAge - Optional maximum age in seconds (default: 300)
 * @returns true if the signature is valid, false otherwise
 */
export function verifyWebhookFromRequest(
  request: { body: string; headers: Record<string, string | string[] | undefined> },
  secret: string,
  maxAge?: number
): boolean {
  const signature = request.headers['x-blaxel-signature'];
  const timestamp = request.headers['x-blaxel-timestamp'];

  if (typeof signature !== 'string') {
    return false;
  }

  return verifyWebhookSignature({
    body: request.body,
    signature,
    secret,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    maxAge
  });
}

