import { describe, it, expect } from 'vitest'
import { verifyWebhookFromRequest } from '@blaxel/core'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'

/**
 * Webhook Verification Tests
 *
 * Tests the webhook signature verification functionality.
 * Note: Full webhook testing with ngrok requires manual setup.
 */

describe('Webhook Verification', () => {
  let server: Server
  let baseUrl: string

  it('verifyWebhookFromRequest rejects invalid signatures', async () => {
    let verificationResult: boolean | null = null

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/webhook') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          // Create a request-like object for verification
          const reqForVerification = {
            body,
            headers: req.headers as Record<string, string | string[] | undefined>
          }
          verificationResult = verifyWebhookFromRequest(reqForVerification, 'test-secret')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ verified: verificationResult }))
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address !== 'string') {
          baseUrl = `http://127.0.0.1:${address.port}`
        }
        resolve()
      })
    })

    // Send a request without proper signature headers
    const response = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'data' }),
    })

    expect(response.status).toBe(200)
    const result = await response.json() as { verified: boolean }
    // Without signature headers, verification should fail
    expect(result.verified).toBe(false)

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })
})
