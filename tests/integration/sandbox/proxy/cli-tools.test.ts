import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup } from './helpers.js'

describe('proxy e2e with common CLI tools', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let cliSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  beforeAll(async () => {
    const name = uniqueName("proxy-cli")
    cliSandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{
            destinations: ["httpbin.org"],
            headers: { "X-Proxy-Test": "header-injected", "X-Api-Key": "{{SECRET:test-api-key}}" },
            body: { "injected_field": "body-injected", "secret_body": "{{SECRET:test-api-key}}" },
            secrets: { "test-api-key": "resolved-secret-42" },
          }],
        },
      },
    })
    createdSandboxes.push(name)

    const install = await cliSandbox.process.exec({ command: 'apk add --no-cache curl wget git python3 py3-pip ca-certificates 2>&1', waitForCompletion: true })
    if (install.exitCode !== 0) throw new Error(`apk install failed: ${install.logs?.slice(0, 500)}`)

    const certInstall = await cliSandbox.process.exec({
      command: '[ -f "$SSL_CERT_FILE" ] && cp "$SSL_CERT_FILE" /usr/local/share/ca-certificates/blaxel-proxy.crt && update-ca-certificates 2>&1 || echo "no SSL_CERT_FILE"',
      waitForCompletion: true,
    })
    if (certInstall.exitCode !== 0) throw new Error(`CA cert install failed: ${certInstall.logs?.slice(0, 500)}`)
  }, 120_000)

  describe('curl', () => {
    it('routes GET requests through the proxy with header injection', async () => {
      const result = await cliSandbox.process.exec({ command: 'curl -s https://httpbin.org/headers', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
      expect(headers["x-api-key"]).toBe("resolved-secret-42")
    }, 60_000)

    it('routes POST requests through the proxy with body injection', async () => {
      const result = await cliSandbox.process.exec({ command: `curl -s -X POST https://httpbin.org/post -H "Content-Type: application/json" -d '{"user_data":"from-curl"}'`, waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const response = parseJsonOutput(result.logs)
      expect(response.json.user_data).toBe("from-curl")
      expect(response.json.injected_field).toBe("body-injected")
      expect(response.json.secret_body).toBe("resolved-secret-42")
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
    }, 60_000)

    it('preserves user-sent headers', async () => {
      const result = await cliSandbox.process.exec({ command: 'curl -s -H "X-User-Custom: from-curl" https://httpbin.org/headers', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
      expect(headers["x-user-custom"]).toBe("from-curl")
      expect(headers["x-proxy-test"]).toBe("header-injected")
      expect(headers["x-api-key"]).toBe("resolved-secret-42")
    }, 60_000)

    it('follows redirects through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: 'curl -s -L -o /dev/null -w "%{http_code}" https://httpbin.org/redirect/1', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs?.trim()).toBe("200")
    }, 60_000)

    it('sends PUT requests through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: `curl -s -X PUT https://httpbin.org/put -H "Content-Type: application/json" -d '{"update":"from-curl"}'`, waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const response = parseJsonOutput(result.logs)
      expect(response.json.update).toBe("from-curl")
      expect(lowercaseKeys(response.headers)["x-proxy-test"]).toBe("header-injected")
    }, 60_000)

    it('sends DELETE requests through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: 'curl -s -X DELETE https://httpbin.org/delete', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(lowercaseKeys(parseJsonOutput(result.logs).headers)["x-proxy-test"]).toBe("header-injected")
    }, 60_000)

    it('handles large response payloads', async () => {
      const result = await cliSandbox.process.exec({ command: 'curl -s -o /dev/null -w "%{http_code} %{size_download}" https://httpbin.org/bytes/10240', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const [statusCode, sizeStr] = (result.logs?.trim() || "").split(" ")
      expect(statusCode).toBe("200")
      expect(parseInt(sizeStr)).toBeGreaterThanOrEqual(10240)
    }, 60_000)
  })

  describe('git', () => {
    it('clones a public repository through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: 'export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY && GIT_SSL_CAINFO=$SSL_CERT_FILE git -c http.proxyAuthMethod=basic clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/git-test-repo 2>&1', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const verify = await cliSandbox.process.exec({ command: 'ls /tmp/git-test-repo/README', waitForCompletion: true })
      expect(verify.exitCode).toBe(0)
    }, 120_000)

    it('git ls-remote works through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: 'export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY && GIT_SSL_CAINFO=$SSL_CERT_FILE git -c http.proxyAuthMethod=basic ls-remote --heads https://github.com/octocat/Hello-World.git 2>&1', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("refs/heads/")
    }, 60_000)

    it('proxy env vars are visible to git', async () => {
      const result = await cliSandbox.process.exec({ command: 'git config --global --list 2>&1; echo "---"; env | grep -i proxy || true', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const logs = result.logs || ""
      expect(logs.toLowerCase().includes("proxy") || logs.includes("HTTPS_PROXY") || logs.includes("https_proxy")).toBe(true)
    }, 30_000)
  })

  describe('pip (Python package manager)', () => {
    it('pip install works through the proxy', async () => {
      const result = await cliSandbox.process.exec({ command: 'pip3 install --break-system-packages --quiet six 2>&1 && python3 -c "import six; print(six.__version__)"', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs?.trim()).toMatch(/\d+\.\d+/)
    }, 120_000)
  })

  describe('npm / npx (Node package manager)', () => {
    it('npm install works through the proxy', async () => {
      await cliSandbox.fs.write("/tmp/npm-test/package.json", JSON.stringify({ name: "proxy-npm-test", version: "1.0.0", dependencies: { "is-odd": "^3.0.1" } }))
      const result = await cliSandbox.process.exec({ command: 'cd /tmp/npm-test && npm install --no-audit --no-fund 2>&1', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const verify = await cliSandbox.process.exec({ command: 'node -e "console.log(require(\'/tmp/npm-test/node_modules/is-odd\')(3))"', waitForCompletion: true })
      expect(verify.exitCode).toBe(0)
      expect(verify.logs?.trim()).toBe("true")
    }, 120_000)
  })
})
