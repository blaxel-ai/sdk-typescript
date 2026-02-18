import { initialize, SandboxInstance, settings } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ClientCredentials } from '../../../@blaxel/core/src/authentication/clientcredentials.js'

const skipTest = !process.env.BL_CLIENT_CREDENTIALS

interface ClientCredentialsTestable {
  accessToken: string
  currentPromise: Promise<void> | null
  token: string
}

function createExpiredJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: 1000000000, iat: 999999900, sub: "test" })).toString('base64url')
  return `${header}.${payload}.fakesig`
}

describe.skipIf(skipTest)('ClientCredentials token auto-refresh', () => {
  const originalCredentials = settings.credentials

  beforeAll(() => {
    initialize({})
    settings.credentials = new ClientCredentials({
      clientCredentials: process.env.BL_CLIENT_CREDENTIALS!,
      workspace: process.env.BL_WORKSPACE,
    })
  })

  afterAll(() => {
    settings.credentials = originalCredentials
  })

  it('refreshes an expired token before making the next API call', async () => {
    const creds = settings.credentials as unknown as ClientCredentialsTestable
    const authenticateSpy = vi.spyOn(settings.credentials, 'authenticate')
    const needRefreshSpy = vi.spyOn(ClientCredentials.prototype, 'needRefresh')
    const processWithRetrySpy = vi.spyOn(ClientCredentials.prototype as never, 'processWithRetry')

    const list1 = await SandboxInstance.list()
    expect(Array.isArray(list1)).toBe(true)

    expect(creds.token).toBeTruthy()
    expect(authenticateSpy).toHaveBeenCalled()
    expect(needRefreshSpy).toHaveBeenCalled()
    expect(needRefreshSpy).toHaveReturnedWith(true)
    expect(processWithRetrySpy).toHaveBeenCalled()

    authenticateSpy.mockClear()
    needRefreshSpy.mockClear()
    processWithRetrySpy.mockClear()

    creds.accessToken = createExpiredJwt()
    creds.currentPromise = null

    const list2 = await SandboxInstance.list()
    expect(Array.isArray(list2)).toBe(true)

    expect(authenticateSpy).toHaveBeenCalled()
    expect(needRefreshSpy).toHaveBeenCalled()
    expect(needRefreshSpy).toHaveReturnedWith(true)
    expect(processWithRetrySpy).toHaveBeenCalled()
    expect(creds.token).toBeTruthy()
    expect(creds.token).not.toBe(createExpiredJwt())

    authenticateSpy.mockRestore()
    needRefreshSpy.mockRestore()
    processWithRetrySpy.mockRestore()
  })
})
