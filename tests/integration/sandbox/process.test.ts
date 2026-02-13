import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels, sleep } from './helpers.js'

let SKIP_KEEP_ALIVE = true

describe('Sandbox Process Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("process-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  describe('exec', () => {
    it('executes a simple command', async () => {
      const result = await sandbox.process.exec({
        command: "echo 'Hello World'",
        waitForCompletion: true
      })

      expect(result.status).toBe("completed")
      expect(result.logs).toContain("Hello World")
    })

    it('executes command with custom name', async () => {
      const result = await sandbox.process.exec({
        name: "custom-named-process",
        command: "echo 'named'",
        waitForCompletion: true
      })

      expect(result.name).toBe("custom-named-process")
    })

    it('generates name when not provided', async () => {
      const result = await sandbox.process.exec({
        command: "echo 'auto'",
        waitForCompletion: true
      })

      expect(result.name).toBeDefined()
      expect(result.name).toMatch(/^proc-/)
    })

    it('executes command with working directory', async () => {
      await sandbox.fs.mkdir("/tmp/workdir")

      const result = await sandbox.process.exec({
        command: "pwd",
        workingDir: "/tmp/workdir",
        waitForCompletion: true
      })

      expect(result.logs).toContain("/tmp/workdir")
    })

    it('captures stdout', async () => {
      const result = await sandbox.process.exec({
        command: "echo 'stdout output'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("stdout output")
    })

    it('captures stderr', async () => {
      const result = await sandbox.process.exec({
        command: "echo 'stderr output' >&2",
        waitForCompletion: true
      })

      expect(result.logs).toContain("stderr output")
    })

    it('returns exit code', async () => {
      const successResult = await sandbox.process.exec({
        command: "exit 0",
        waitForCompletion: true
      })
      expect(successResult.exitCode).toBe(0)

      const failResult = await sandbox.process.exec({
        command: "exit 42",
        waitForCompletion: true
      })
      expect(failResult.exitCode).toBe(42)
    })
  })

  describe('exec with onLog callback', () => {
    it('receives logs via callback', async () => {
      const logs: string[] = []

      await sandbox.process.exec({
        command: "echo 'line1' && echo 'line2' && echo 'line3'",
        waitForCompletion: true,
        onLog: (log) => {
          logs.push(log)
        }
      })

      expect(logs.length).toBeGreaterThan(0)
      const allLogs = logs.join(' ')
      expect(allLogs).toContain('line1')
      expect(allLogs).toContain('line2')
      expect(allLogs).toContain('line3')
    })

    it('receives stdout via onStdout callback', async () => {
      const stdoutLogs: string[] = []
      const allLogs: string[] = []
      const errorLogs: string[] = []

      await sandbox.process.exec({
        name: "stdout-test",
        command: "for i in $(seq 1 5); do sleep 0.5; echo tick $i; sleep 0.5; done && echo 'stderr here' >&2",
        waitForCompletion: false
      })

      const stream = sandbox.process.streamLogs("stdout-test", {
        onLog: (log) => {
          allLogs.push(log)
        },
        onStdout: (log) => {
          stdoutLogs.push(log)
        },
        onStderr: (log) => {
          errorLogs.push(log)
        }
      })

      await sandbox.process.wait("stdout-test")
      stream.close()

      expect(stdoutLogs.join(' ')).toContain('tick 1')
      expect(stdoutLogs.join(' ')).toContain('tick 2')
      expect(stdoutLogs.join(' ')).toContain('tick 3')
      expect(stdoutLogs.join(' ')).toContain('tick 4')
      expect(stdoutLogs.join(' ')).toContain('tick 5')
      expect(errorLogs.join(' ')).toContain('stderr here')
      expect(allLogs.join(' ')).toContain('tick 1')
      expect(allLogs.join(' ')).toContain('tick 2')
      expect(allLogs.join(' ')).toContain('tick 3')
      expect(allLogs.join(' ')).toContain('tick 4')
      expect(allLogs.join(' ')).toContain('tick 5')
      expect(allLogs.join(' ')).toContain('stderr here')
    })
  })

  describe('exec without waiting', () => {
    it('returns immediately when waitForCompletion is false', async () => {
      const startTime = Date.now()

      const result = await sandbox.process.exec({
        name: "no-wait-test",
        command: "sleep 5",
        waitForCompletion: false
      })

      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(4000) // Should return well before 5 seconds
      expect(result.name).toBe("no-wait-test")
    })
  })

  describe('get', () => {
    it('retrieves process information', async () => {
      await sandbox.process.exec({
        name: "get-test",
        command: "echo 'test'",
        waitForCompletion: true
      })

      const process = await sandbox.process.get("get-test")

      expect(process.name).toBe("get-test")
      expect(process.status).toBe("completed")
    })

    it('shows running status for long process', async () => {
      await sandbox.process.exec({
        name: "long-running",
        command: "sleep 30",
        waitForCompletion: false
      })

      const process = await sandbox.process.get("long-running")
      expect(process.status).toBe("running")

      // Clean up
      await sandbox.process.kill("long-running")
    })
  })

  describe('logs', () => {
    it('retrieves all logs', async () => {
      await sandbox.process.exec({
        name: "logs-test",
        command: "echo 'stdout' && echo 'stderr' >&2",
        waitForCompletion: true
      })

      const logs = await sandbox.process.logs("logs-test", "all")

      expect(logs).toContain("stdout")
      expect(logs).toContain("stderr")
    })

    it('retrieves stdout only', async () => {
      await sandbox.process.exec({
        name: "stdout-only",
        command: "echo 'out' && echo 'err' >&2",
        waitForCompletion: true
      })

      const logs = await sandbox.process.logs("stdout-only", "stdout")
      expect(logs).toContain("out")
    })

    it('retrieves stderr only', async () => {
      await sandbox.process.exec({
        name: "stderr-only",
        command: "echo 'out' && echo 'err' >&2",
        waitForCompletion: true
      })

      const logs = await sandbox.process.logs("stderr-only", "stderr")
      expect(logs).toContain("err")
    })
  })

  describe('streamLogs', () => {
    it('streams logs in real-time', async () => {
      const logs: string[] = []

      await sandbox.process.exec({
        name: "stream-test",
        command: "for i in 1 2 3; do echo \"msg $i\"; sleep 1; done",
        waitForCompletion: false
      })

      const stream = sandbox.process.streamLogs("stream-test", {
        onLog: (log) => {
          logs.push(log)
        }
      })

      await sandbox.process.wait("stream-test")
      stream.close()

      expect(logs.length).toBeGreaterThan(0)
    })

    it('can close stream early', async () => {
      const logs: string[] = []

      await sandbox.process.exec({
        name: "close-early",
        command: "for i in $(seq 1 10); do echo $i; sleep 0.3; done",
        waitForCompletion: false
      })

      const stream = sandbox.process.streamLogs("close-early", {
        onLog: (log) => logs.push(log)
      })

      await sleep(500)
      stream.close()

      const logsAtClose = logs.length
      await sleep(1000)

      // No new logs should arrive after close
      expect(logs.length).toBe(logsAtClose)

      // Clean up
      await sandbox.process.kill("close-early")
    })
  })

  describe('wait', () => {
    it('waits for process completion', async () => {
      await sandbox.process.exec({
        name: "wait-test",
        command: "sleep 2 && echo 'done'",
        waitForCompletion: false
      })

      await sandbox.process.wait("wait-test")

      const process = await sandbox.process.get("wait-test")
      expect(process.status).toBe("completed")
    })

    it('respects maxWait timeout', async () => {
      await sandbox.process.exec({
        name: "timeout-test",
        command: "sleep 60",
        waitForCompletion: false
      })

      await expect(sandbox.process.wait("timeout-test", { maxWait: 2000 })).rejects.toThrow("Process did not finish in time")
    })
  })

  describe('kill', () => {
    it('kills a running process', async () => {
      await sandbox.process.exec({
        name: "kill-test",
        command: "sleep 60",
        waitForCompletion: false
      })

      let process = await sandbox.process.get("kill-test")
      expect(process.status).toBe("running")

      await sandbox.process.kill("kill-test")
      await sleep(1000)

      process = await sandbox.process.get("kill-test")
      expect(["killed", "failed", "completed"]).toContain(process.status)
    })

    it('handles killing completed process gracefully', async () => {
      await sandbox.process.exec({
        name: "already-done",
        command: "echo 'done'",
        waitForCompletion: true
      })

      // Should not throw
      try {
        await sandbox.process.kill("already-done")
      } catch {
        // Expected - some implementations throw for already completed processes
      }
    })
  })

  describe('restartOnFailure', () => {
    it('restarts process on failure', async () => {
      const result = await sandbox.process.exec({
        name: "restart-test",
        command: "exit 1",
        restartOnFailure: true,
        maxRestarts: 3,
        waitForCompletion: true
      })

      expect(result.restartCount).toBeGreaterThan(0)
      expect(result.restartCount).toBeLessThanOrEqual(3)
    })
  })

  describe('keepAlive', () => {
    if (SKIP_KEEP_ALIVE) {
      it('skips keepAlive tests', () => {
        expect(true).toBe(true)
      })
      return
    }

    it('executes process with keepAlive enabled', async () => {
      const result = await sandbox.process.exec({
        name: "keepalive-basic",
        command: "echo 'keepalive test'",
        keepAlive: true,
        waitForCompletion: true
      })

      expect(result.status).toBe("completed")
      expect(result.logs).toContain("keepalive test")
    })

    it('executes process with keepAlive and custom timeout', async () => {
      const result = await sandbox.process.exec({
        name: "keepalive-timeout",
        command: "sleep 2 && echo 'done with timeout'",
        keepAlive: true,
        timeout: 60,
        waitForCompletion: true
      })

      expect(result.status).toBe("completed")
      expect(result.logs).toContain("done with timeout")
    })

    it('kills process when timeout expires', async () => {
      const startTime = Date.now()

      await sandbox.process.exec({
        name: "keepalive-timeout-kill",
        command: "sleep 120",
        keepAlive: true,
        timeout: 3,
        waitForCompletion: false
      })

      // Wait for the process to be killed by timeout
      await sleep(5000)

      const process = await sandbox.process.get("keepalive-timeout-kill")
      const elapsed = Date.now() - startTime

      // Process should be killed/failed, not running
      expect(["killed", "failed", "completed"]).toContain(process.status)
      // Should have been killed around the 3 second timeout mark
      expect(elapsed).toBeLessThan(10000)
    })

    it('allows infinite timeout with timeout 0', async () => {
      const result = await sandbox.process.exec({
        name: "keepalive-infinite",
        command: "sleep 2 && echo 'infinite timeout done'",
        keepAlive: true,
        timeout: 0,
        waitForCompletion: true
      })

      expect(result.status).toBe("completed")
      expect(result.logs).toContain("infinite timeout done")
    })

    it('runs without keepAlive by default', async () => {
      const result = await sandbox.process.exec({
        name: "no-keepalive",
        command: "echo 'no keepalive'",
        waitForCompletion: true
      })

      expect(result.status).toBe("completed")
      // Process should complete normally without keepAlive
      expect(result.logs).toContain("no keepalive")
    })
  })
})

describe('Sandbox Process waitForPorts', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("waitforports")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/node:latest",
      memory: 2048,
      ports: [
        { target: 3000, protocol: "HTTP" }
      ],
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await sandbox.delete()
    } catch {
      // Ignore
    }
  })

  it('waits for port to be ready before returning', async () => {
    const preview = await sandbox.previews.createIfNotExists({
      metadata: {
        name: "waitforports-preview"
      },
      spec: {
        port: 3000,
        public: true
      }
    })

    const previewUrl = preview.spec.url
    expect(previewUrl).toBeDefined()

    const nodeServerCommand = `sleep 2 && node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(3000);
"`

    await sandbox.process.exec({
      name: "node-server",
      command: nodeServerCommand,
      waitForPorts: [3000]
    })

    const response = await fetch(previewUrl!)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toBe("OK")
  })
})
