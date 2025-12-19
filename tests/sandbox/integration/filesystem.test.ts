import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, sleep } from './helpers'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { stat, readFile } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const assetsDir = join(__dirname, '../fixtures/assets')

describe('Sandbox Filesystem Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("fs-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  describe('write and read', () => {
    it('writes and reads a text file', async () => {
      const content = "Hello, World!"
      const path = "/tmp/test-write.txt"

      await sandbox.fs.write(path, content)
      const result = await sandbox.fs.read(path)

      expect(result).toBe(content)
    })

    it('writes and reads unicode content', async () => {
      const content = "Hello 世界 🌍 émojis"
      const path = "/tmp/test-unicode.txt"

      await sandbox.fs.write(path, content)
      const result = await sandbox.fs.read(path)

      expect(result).toBe(content)
    })

    it('writes and reads multiline content', async () => {
      const content = "Line 1\nLine 2\nLine 3"
      const path = "/tmp/test-multiline.txt"

      await sandbox.fs.write(path, content)
      const result = await sandbox.fs.read(path)

      expect(result).toBe(content)
    })

    it('overwrites existing file', async () => {
      const path = "/tmp/test-overwrite.txt"

      await sandbox.fs.write(path, "original")
      await sandbox.fs.write(path, "updated")

      const result = await sandbox.fs.read(path)
      expect(result).toBe("updated")
    })
  })

  describe('writeBinary and readBinary', () => {
    it('writes and reads binary file from local path', async () => {
      const localPath = join(assetsDir, 'archive.zip')
      const remotePath = "/tmp/uploaded.zip"

      // Skip if asset doesn't exist
      try {
        await stat(localPath)
      } catch {
        console.log('Skipping binary test - archive.zip not found')
        return
      }

      await sandbox.fs.writeBinary(remotePath, localPath)

      const blob = await sandbox.fs.readBinary(remotePath)
      expect(blob instanceof Blob).toBe(true)
      expect(blob.size).toBeGreaterThan(0)
    })

    it('readBinary works on text files too', async () => {
      const path = "/tmp/test-binary-text.txt"
      await sandbox.fs.write(path, "text content")

      const blob = await sandbox.fs.readBinary(path)
      expect(blob instanceof Blob).toBe(true)

      const text = await blob.text()
      expect(text).toBe("text content")
    })
  })

  describe('download', () => {
    it('downloads file to local filesystem', async () => {
      const remotePath = "/tmp/download-test.txt"
      const localPath = join(__dirname, '../fixtures/downloaded.txt')
      const content = "download test content"

      await sandbox.fs.write(remotePath, content)
      await sandbox.fs.download(remotePath, localPath)

      const downloaded = await readFile(localPath, 'utf-8')
      expect(downloaded).toBe(content)

      // Cleanup local file
      const { unlink } = await import('fs/promises')
      await unlink(localPath).catch(() => {})
    })
  })

  describe('ls (list directory)', () => {
    it('lists files in a directory', async () => {
      // Create some test files
      await sandbox.fs.write("/tmp/ls-test/file1.txt", "content1")
      await sandbox.fs.write("/tmp/ls-test/file2.txt", "content2")

      const listing = await sandbox.fs.ls("/tmp/ls-test")

      expect(listing.files).toBeDefined()
      expect(listing.files?.length).toBeGreaterThanOrEqual(2)

      const names = listing.files?.map(f => f.name)
      expect(names).toContain("file1.txt")
      expect(names).toContain("file2.txt")
    })

    it('lists subdirectories', async () => {
      await sandbox.fs.mkdir("/tmp/ls-subdir-test/subdir1")
      await sandbox.fs.mkdir("/tmp/ls-subdir-test/subdir2")

      const listing = await sandbox.fs.ls("/tmp/ls-subdir-test")

      expect(listing.subdirectories).toBeDefined()
      const names = listing.subdirectories?.map(d => d.name)
      expect(names).toContain("subdir1")
      expect(names).toContain("subdir2")
    })

    it('returns file metadata', async () => {
      await sandbox.fs.write("/tmp/meta-test.txt", "some content")
      const listing = await sandbox.fs.ls("/tmp")

      const file = listing.files?.find(f => f.name === "meta-test.txt")
      expect(file).toBeDefined()
      expect(file?.path).toBe("/tmp/meta-test.txt")
    })
  })

  describe('mkdir', () => {
    it('creates a directory', async () => {
      const path = "/tmp/new-dir-" + Date.now()
      await sandbox.fs.mkdir(path)

      const listing = await sandbox.fs.ls(path)
      expect(listing).toBeDefined()
    })

    it('creates nested directories', async () => {
      const path = `/tmp/nested-${Date.now()}/level1/level2`
      await sandbox.fs.mkdir(path)

      const listing = await sandbox.fs.ls(path)
      expect(listing).toBeDefined()
    })
  })

  describe('cp (copy)', () => {
    it('copies a file', async () => {
      const src = "/tmp/cp-src.txt"
      const dst = "/tmp/cp-dst.txt"

      await sandbox.fs.write(src, "copy me")
      await sandbox.fs.cp(src, dst)

      const content = await sandbox.fs.read(dst)
      expect(content).toBe("copy me")
    })

    it('copies a directory', async () => {
      const srcDir = "/tmp/cp-dir-src"
      const dstDir = "/tmp/cp-dir-dst"

      await sandbox.fs.write(`${srcDir}/file.txt`, "content")
      await sandbox.fs.cp(srcDir, dstDir)

      const content = await sandbox.fs.read(`${dstDir}/file.txt`)
      expect(content).toBe("content")
    })
  })

  describe('rm (remove)', () => {
    it('removes a file', async () => {
      const path = "/tmp/rm-file.txt"
      await sandbox.fs.write(path, "delete me")

      await sandbox.fs.rm(path)

      // File should no longer exist
      await expect(sandbox.fs.read(path)).rejects.toThrow()
    })

    it('removes a directory recursively', async () => {
      const dir = "/tmp/rm-dir"
      await sandbox.fs.write(`${dir}/file.txt`, "content")
      await sandbox.fs.mkdir(`${dir}/subdir`)

      await sandbox.fs.rm(dir, true) // recursive

      await expect(sandbox.fs.ls(dir)).rejects.toThrow()
    })

    it('fails to remove non-empty directory without recursive flag', async () => {
      const dir = "/tmp/rm-nonempty"
      await sandbox.fs.write(`${dir}/file.txt`, "content")

      await expect(sandbox.fs.rm(dir, false)).rejects.toThrow()
    })
  })

  describe('watch', () => {
    it('watches for file changes', async () => {
      const dir = "/tmp/watch-test-" + Date.now()
      await sandbox.fs.mkdir(dir)

      let changeDetected = false
      const handle = sandbox.fs.watch(dir, (event) => {
        if (event.name === "watched-file.txt") {
          changeDetected = true
        }
      })

      await sleep(200)
      // Trigger a file change
      await sandbox.fs.write(`${dir}/watched-file.txt`, "new content")

      // Wait for callback
      await sleep(100)
      handle.close()

      expect(changeDetected).toBe(true)
    })

    it('watches with content option', async () => {
      const dir = "/tmp/watch-content-" + Date.now()
      await sandbox.fs.mkdir(dir)

      let receivedContent = ""
      const handle = sandbox.fs.watch(
        dir,
        (event) => {
          if (event.content) {
            receivedContent = event.content
          }
        },
        { withContent: true }
      )
      await sleep(200)
      await sandbox.fs.write(`${dir}/content-file.txt`, "the content")

      await sleep(100)
      handle.close()

      expect(receivedContent).toBe("the content")
    })
  })

  describe('multipart upload (large files)', () => {
    it('uploads small file (< 1MB) via regular upload', async () => {
      const content = "Hello, world! ".repeat(1000) // ~14KB
      const path = "/tmp/small-upload.txt"

      await sandbox.fs.write(path, content)

      const result = await sandbox.fs.read(path)
      expect(result).toBe(content)
    })

    it('uploads large text file (> 1MB) via multipart', async () => {
      const content = "Large file content line. ".repeat(50000) // ~1.2MB
      const path = "/tmp/large-upload.txt"

      await sandbox.fs.write(path, content)

      const result = await sandbox.fs.read(path)
      expect(result.length).toBe(content.length)
      expect(result).toBe(content)
    })

    it('uploads large binary file via multipart', async () => {
      const size = 2 * 1024 * 1024 // 2MB
      const binaryContent = new Uint8Array(size)
      // Fill with pattern for verification
      for (let i = 0; i < size; i++) {
        binaryContent[i] = i % 256
      }
      const path = "/tmp/large-binary-upload.bin"

      await sandbox.fs.writeBinary(path, binaryContent)

      const blob = await sandbox.fs.readBinary(path)
      const result = new Uint8Array(await blob.arrayBuffer())

      expect(result.length).toBe(size)
      expect(result.every((val, idx) => val === idx % 256)).toBe(true)
    })

    it('uploads very large file (> 5MB) with multiple parts', async () => {
      const content = "X".repeat(6 * 1024 * 1024) // 6MB
      const path = "/tmp/very-large-upload.txt"

      await sandbox.fs.write(path, content)

      const result = await sandbox.fs.read(path)
      expect(result.length).toBe(content.length)
    })
  })

  describe('parallel operations', () => {
    it('handles 100 parallel file reads', async () => {
      // Create a test file
      const content = "A".repeat(200 * 1024) // 200KB
      const path = "/tmp/parallel-read.txt"
      await sandbox.fs.write(path, content)

      // Make 100 parallel read calls
      const promises = Array.from({ length: 100 }, () =>
        sandbox.fs.read(path).then(fileContent => fileContent.length)
      )

      const results = await Promise.all(promises)

      // All reads should return the same size
      expect(results.every(size => size === content.length)).toBe(true)
    })
  })
})
