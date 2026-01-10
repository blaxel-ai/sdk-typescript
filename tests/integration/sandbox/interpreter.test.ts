import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { CodeInterpreter } from "@blaxel/core"
import { uniqueName, defaultLabels } from './helpers.js'

describe('CodeInterpreter Operations', () => {
  let interpreter: CodeInterpreter
  const interpreterName = uniqueName("interp")

  beforeAll(async () => {
    interpreter = await CodeInterpreter.create({
      name: interpreterName,
      labels: defaultLabels,
    })
  }, 180000) // 3 minute timeout for interpreter creation

  afterAll(async () => {
    if (interpreter?.metadata.name) {
      try {
        await CodeInterpreter.delete(interpreter.metadata.name)
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  describe('create', () => {
    it('creates a code interpreter', () => {
      expect(interpreter.metadata.name).toBeDefined()
    })
  })

  describe('createCodeContext', () => {
    it('creates a Python code context', async () => {
      const ctx = await interpreter.createCodeContext({ language: "python" })

      expect(ctx).toBeDefined()
      expect(ctx.id).toBeDefined()
    })
  })

  describe('runCode', () => {
    it('executes simple Python code', async () => {
      const stdoutLines: string[] = []

      await interpreter.runCode("print('Hello from interpreter')", {
        language: "python",
        onStdout: (msg) => {
          stdoutLines.push(msg.text)
        },
        timeout: 30.0,
      })

      expect(stdoutLines.join('')).toContain('Hello from interpreter')
    })

    it('captures stderr output', async () => {
      const stderrLines: string[] = []

      await interpreter.runCode("import sys; sys.stderr.write('error message')", {
        language: "python",
        onStderr: (msg) => {
          stderrLines.push(msg.text)
        },
        timeout: 30.0,
      })

      expect(stderrLines.join('')).toContain('error message')
    })

    it('returns execution results', async () => {
      const results: InstanceType<typeof CodeInterpreter.Result>[] = []

      await interpreter.runCode("2 + 2", {
        language: "python",
        onResult: (res) => {
          results.push(res)
        },
        timeout: 30.0,
      })

      expect(results.length).toBeGreaterThan(0)
    })

    it('captures execution errors', async () => {
      const errors: InstanceType<typeof CodeInterpreter.ExecutionError>[] = []

      await interpreter.runCode("raise ValueError('test error')", {
        language: "python",
        onError: (err) => {
          errors.push(err)
        },
        timeout: 30.0,
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].name).toBe('ValueError')
    })

    it('persists state across runs', async () => {
      // Define a function in first run
      await interpreter.runCode("def add(a, b):\n    return a + b", {
        language: "python",
        timeout: 30.0,
      })

      // Call the function in second run
      const stdoutLines: string[] = []
      await interpreter.runCode("print(add(2, 3))", {
        language: "python",
        onStdout: (msg) => {
          stdoutLines.push(msg.text)
        },
        timeout: 30.0,
      })

      expect(stdoutLines.join('')).toContain('5')
    })

    it('handles variables across runs', async () => {
      // Set variable
      await interpreter.runCode("x = 42", {
        language: "python",
        timeout: 30.0,
      })

      // Read variable
      const stdoutLines: string[] = []
      await interpreter.runCode("print(x)", {
        language: "python",
        onStdout: (msg) => {
          stdoutLines.push(msg.text)
        },
        timeout: 30.0,
      })

      expect(stdoutLines.join('')).toContain('42')
    })
  })

  describe('static methods', () => {
    it('gets an existing interpreter', async () => {
      const retrieved = await CodeInterpreter.get(interpreter.metadata.name ?? '')

      expect(retrieved.metadata.name).toBe(interpreter.metadata.name)
    })
  })
})
