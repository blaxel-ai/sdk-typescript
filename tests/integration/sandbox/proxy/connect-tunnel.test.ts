import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { execProxyCommandWithRetry, parseJsonOutput, proxyCleanup } from './helpers.js'

type PythonProxyOutput = {
  status: number
  body: string
  error?: string
}

/**
 * CONNECT tunnel coverage:
 *  - Python `urllib3` request to `https://storage.googleapis.com/...`
 *    over CONNECT with ProxyTarget `Authorization: Bearer <token>` injection.
 *  - `pip install` over CONNECT (pip uses its own HTTPS stack against pypi.org).
 *  - `gcsfuse` against a real GCS bucket WITHOUT `--client-protocol=http1`, which
 *    forces the Go GCS client to use HTTP/2 over the CONNECT tunnel. Only runs when
 *    `BL_TEST_GCS_BUCKET` + `GCSFUSE_SA_KEY_JSON` are provided.
 */
describe('proxy CONNECT tunnel support', () => {
  const unsetHttpProxyEnv = 'env -u HTTP_PROXY -u http_proxy'

  describe('Python urllib3 through CONNECT', () => {
    const createdSandboxes: string[] = []
    afterAll(proxyCleanup(createdSandboxes))

    let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    const urllib3HelperScript = `
import os, sys, json, urllib.parse, urllib3
method = sys.argv[1] if len(sys.argv) > 1 else "GET"
url = sys.argv[2] if len(sys.argv) > 2 else "https://storage.googleapis.com/storage/v1/b/blaxel-sdk-nonexistent-bucket-for-test/o"
headers = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
body = sys.argv[4].encode() if len(sys.argv) > 4 else None
try:
    proxy_url = os.environ["HTTPS_PROXY"]
    proxy_auth = urllib.parse.unquote(urllib.parse.urlsplit(proxy_url).netloc.rsplit("@", 1)[0])
    http = urllib3.ProxyManager(
        proxy_url,
        proxy_headers=urllib3.make_headers(proxy_basic_auth=proxy_auth),
        cert_reqs="CERT_REQUIRED",
        ca_certs=os.environ.get("SSL_CERT_FILE"),
    )
    resp = http.request(method, url, body=body, headers=headers, timeout=urllib3.Timeout(connect=10, read=30), retries=False)
    print(json.dumps({"status": resp.status, "body": resp.data.decode("utf-8", errors="replace")}))
except urllib3.exceptions.HTTPError as e:
    print(json.dumps({"status": 0, "body": str(e), "error": e.__class__.__name__}))
`.trim()

    beforeAll(async () => {
      const name = uniqueName("proxy-urllib")
      sandbox = await SandboxInstance.create({
        name, image: "blaxel/py-app:latest", region: defaultRegion, labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["storage.googleapis.com"],
                headers: { "Authorization": "Bearer {{SECRET:gcp-token}}" },
                secrets: { "gcp-token": "fake-bearer-token-for-connect-test-42" },
              },
              {
                destinations: ["pypi.org", "files.pythonhosted.org"],
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)
      const install = await sandbox.process.exec({
        command: `${unsetHttpProxyEnv} pip install --break-system-packages --quiet --no-cache-dir urllib3 2>&1`,
        waitForCompletion: true,
      })
      expect(install.exitCode, install.logs).toBe(0)
      await sandbox.fs.write("/tmp/urllib3-test.py", urllib3HelperScript)
    }, 120_000)

    it('urllib3 reaches GCS through CONNECT with proxy-injected Authorization', async () => {
      const result = await execProxyCommandWithRetry(
        sandbox,
        `${unsetHttpProxyEnv} python3 /tmp/urllib3-test.py GET https://storage.googleapis.com/storage/v1/b/blaxel-sdk-nonexistent-bucket-for-test/o 2>&1`,
        { retries: 0, delayMs: 3000 },
      )
      expect(result.exitCode, result.logs).toBe(0)
      const out = parseJsonOutput(result.logs) as PythonProxyOutput
      // The fake bearer token should be injected by the proxy and rejected by GCS.
      expect([401, 403], `expected auth-related 4xx from GCS, got ${out.status}: ${out.body?.slice(0, 300)}`).toContain(out.status)
      expect(out.body.toLowerCase()).toMatch(/auth|credential|permission|forbidden|invalid/)
    }, 90_000)
  })

  describe('pip install through CONNECT', () => {
    const createdSandboxes: string[] = []
    afterAll(proxyCleanup(createdSandboxes))

    let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("proxy-pip-ct")
      sandbox = await SandboxInstance.create({
        name, image: "blaxel/py-app:latest", region: defaultRegion, labels: defaultLabels,
        network: {
          proxy: {
            // Global rule (no header/body injection) -- enables the proxy and lets pip
            // CONNECT to pypi.org + files.pythonhosted.org. `routing: []` alone does NOT
            // enable the proxy (HTTPS_PROXY env var is not set in that case).
            routing: [{ destinations: ["*"] }],
          },
        },
      })
      createdSandboxes.push(name)
    }, 120_000)

    it('HTTP_PROXY and HTTPS_PROXY env vars are set in sandbox', async () => {
      const result = await sandbox.process.exec({
        command: 'echo "HTTPS_PROXY=${HTTPS_PROXY}"; echo "HTTP_PROXY=${HTTP_PROXY}"; echo "SSL_CERT_FILE=${SSL_CERT_FILE}"',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
      const out = result.logs || ""
      expect(out, `proxy env vars missing in sandbox:\n${out}`).toMatch(/HTTPS_PROXY=https:\/\/\S+/)
      expect(out).toMatch(/HTTP_PROXY=https:\/\/\S+/)
      expect(out).toMatch(/SSL_CERT_FILE=\/\S+/)
    }, 30_000)

    it('installs a package from PyPI using HTTPS_PROXY only', async () => {
      // No --proxy flag: pip/urllib3 should pick up HTTPS_PROXY for HTTPS URLs.
      const result = await execProxyCommandWithRetry(
        sandbox,
        `${unsetHttpProxyEnv} pip install --break-system-packages --quiet --no-cache-dir idna 2>&1 && pip show idna 2>&1 | grep -E "^Version:"`,
        { retries: 5, delayMs: 3000 },
      )
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs?.trim()).toMatch(/Version:\s+\d+\.\d+/)
    }, 240_000)
  })

  describe('gcsfuse with native HTTP/2 (no --client-protocol=http1)', () => {
    const bucket = process.env.BL_TEST_GCS_BUCKET
    const saKeyJson = process.env.GCSFUSE_SA_KEY_JSON

    if (!bucket || !saKeyJson) {
      it.skip('requires BL_TEST_GCS_BUCKET + GCSFUSE_SA_KEY_JSON env vars', () => {})
      return
    }

    const createdSandboxes: string[] = []
    afterAll(proxyCleanup(createdSandboxes))

    let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("proxy-gcsfuse")
      sandbox = await SandboxInstance.create({
        name, image: "blaxel/py-app:latest", region: defaultRegion, labels: defaultLabels,
        network: {
          proxy: {
            routing: [{
              destinations: ["storage.googleapis.com", "*.googleapis.com", "oauth2.googleapis.com"],
            }],
          },
        },
      })
      createdSandboxes.push(name)

      // Stage the service account key inside the sandbox.
      await sandbox.fs.write("/tmp/sa-key.json", saKeyJson)

      // Best-effort gcsfuse install. The official .deb works on Debian/Ubuntu bases.
      // We fall back to apt-based install if the image supports it; the test fails
      // loudly if the binary is unavailable so the user knows to bring their own image.
      const install = await sandbox.process.exec({
        command: [
          'set -e',
          'export DEBIAN_FRONTEND=noninteractive',
          '(command -v gcsfuse && gcsfuse --version) || (',
          '  apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates fuse3 lsb-release gnupg 2>&1 || true ;',
          '  export GCSFUSE_REPO=gcsfuse-$(lsb_release -c -s 2>/dev/null || echo bookworm) ;',
          '  echo "deb https://packages.cloud.google.com/apt $GCSFUSE_REPO main" > /etc/apt/sources.list.d/gcsfuse.list ;',
          '  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key add - 2>/dev/null || true ;',
          '  apt-get update -qq && apt-get install -y --no-install-recommends gcsfuse',
          ')',
          'gcsfuse --version',
        ].join(' ; ') + ' 2>&1',
        waitForCompletion: true,
      })
      if (install.exitCode !== 0) {
        throw new Error(`gcsfuse install failed (try a Debian-based image with FUSE access). exitCode=${install.exitCode}; logs=${install.logs?.slice(0, 1500)}`)
      }
    }, 600_000)

    it('mounts a GCS bucket through the proxy CONNECT tunnel using HTTP/2', async () => {
      const mountCmd = [
        'set -e',
        'mkdir -p /mnt/gcs',
        'export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa-key.json',
        // No --client-protocol=http1 here: gcsfuse will default to HTTP/2 over
        // the proxy's CONNECT tunnel, exercising end-to-end h2 ALPN through MITM.
        `gcsfuse --foreground=false --debug_fuse --debug_gcs --log-severity=trace ${bucket} /mnt/gcs`,
        'sleep 2',
        // List bucket root and verify mountpoint is live.
        'ls -la /mnt/gcs | head -20',
        'mountpoint /mnt/gcs',
        // Clean up.
        '(fusermount3 -u /mnt/gcs || fusermount -u /mnt/gcs || umount /mnt/gcs) 2>&1 || true',
      ].join(' && ')

      const result = await sandbox.process.exec({
        command: mountCmd + ' 2>&1',
        waitForCompletion: true,
      })
      expect(result.exitCode, `gcsfuse without --client-protocol=http1 failed. logs=${result.logs?.slice(0, 3000)}`).toBe(0)
      expect(result.logs || '').toContain('is a mountpoint')
    }, 300_000)
  })
})
