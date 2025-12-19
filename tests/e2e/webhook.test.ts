import { describe, it, expect } from 'vitest'
import { verifyWebhookFromRequest } from '@blaxel/core'
import express, { Request, Response } from 'express'
import { createServer, Server } from 'http'

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
    const app = express()
    app.use(express.text({ type: 'application/json' }))

    let verificationResult: boolean | null = null

    app.post('/webhook', (req: Request, res: Response) => {
      verificationResult = verifyWebhookFromRequest(req, 'test-secret')
      res.json({ verified: verificationResult })
    })

    server = createServer(app)

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
    const result = await response.json()

    // Without signature headers, verification should fail
    expect(result.verified).toBe(false)

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })
})

