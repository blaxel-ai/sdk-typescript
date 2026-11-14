import { getSandbox, SandboxInstance, VolumeInstance } from "@blaxel/core"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, sleep, uniqueName, waitForSandboxDeletion } from "./helpers.js"

// What a sandbox can do with a persistent volume: permissions, read-only mounts,
// resize, the filesystem API, and state that must survive a standby.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const MOUNT = "/data"

const createdSandboxes: string[] = []
const createdVolumes: string[] = []

afterAll(async () => {
  if (process.env.SKIP_CLEANUP === "1") return
  await Promise.all(createdSandboxes.map(async (name) => {
    await SandboxInstance.delete(name).catch(() => {})
    await waitForSandboxDeletion(name).catch(() => {})
  }))
  // A volume can only be deleted once no sandbox holds it.
  await Promise.all(createdVolumes.map(async (name) => {
    for (let i = 0; i < 30; i++) {
      try { await VolumeInstance.delete(name); return } catch { await sleep(5000) }
    }
  }))
}, 600_000)

// Attaching a volume that is still DEPLOYING fails, so wait until it is ready.
async function newVolume(prefix: string, size: number): Promise<string> {
  const name = uniqueName(prefix)
  createdVolumes.push(name)
  await VolumeInstance.create({ name, size, region: defaultRegion, labels: defaultLabels })
  for (let i = 0; i < 60 && (await VolumeInstance.get(name)).status === "DEPLOYING"; i++) await sleep(1000)
  expect((await VolumeInstance.get(name)).status).toBe("DEPLOYED")
  return name
}

// Registered before create, so a sandbox that fails to deploy is still deleted
// and cannot keep its volume attached.
async function newSandbox(volume: string, { readOnly = false, memory = 2048 } = {}): Promise<SandboxInstance> {
  const name = uniqueName("volbeh")
  createdSandboxes.push(name)
  const sandbox = await SandboxInstance.create({
    name,
    image: defaultImage,
    memory,
    region: defaultRegion,
    volumes: [{ name: volume, mountPath: MOUNT, readOnly }],
    labels: defaultLabels,
  })
  return sandbox
}

// Commands over a minute run in the background and are waited on: a long
// waitForCompletion can time out over HTTP while the command keeps running.
async function sh(sandbox: SandboxInstance, command: string, timeout = 60): Promise<{ exitCode: number, logs: string }> {
  const wrapped = `sh -c '${command.replace(/'/g, `'\\''`)}'`
  if (timeout <= 60) {
    const res = await sandbox.process.exec({ command: wrapped, waitForCompletion: true, timeout })
    return { exitCode: res.exitCode, logs: res.logs.trim() }
  }
  const name = uniqueName("cmd")
  await sandbox.process.exec({ name, command: wrapped, timeout })
  const res = await sandbox.process.wait(name, { maxWait: timeout * 1000, interval: 2000 })
  return { exitCode: res.exitCode, logs: (await sandbox.process.logs(name)).trim() }
}

// The guest caches attributes; dropping its caches makes stat ask the volume.
async function statOnVolume(sandbox: SandboxInstance, format: string, path: string): Promise<string> {
  return (await sh(sandbox, `sync; echo 3 > /proc/sys/vm/drop_caches; stat -c "${format}" ${path}`)).logs
}

async function deleteSandbox(sandbox: SandboxInstance) {
  await SandboxInstance.delete(sandbox.metadata.name)
  await waitForSandboxDeletion(sandbox.metadata.name)
}

// Parks the sandbox by leaving it idle until the control plane reports STANDBY,
// then wakes it with a command. Returns false if it never reached standby.
async function parkAndWake(sandbox: SandboxInstance, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let parked = false
  while (Date.now() < deadline) {
    const { data } = await getSandbox({ path: { sandboxName: sandbox.metadata.name }, throwOnError: true })
    if (data.state === "STANDBY") { parked = true; break }
    await sleep(5000)
  }
  await sh(sandbox, "true")
  return parked
}

describe.runIf(isSlowTestEnabled("RUN_VOLUME_TESTS"))("volume behaviour", () => {
  describe("ownership and modes", () => {
    let sandbox: SandboxInstance

    beforeAll(async () => {
      sandbox = await newSandbox(await newVolume("own", 512))
      await sh(sandbox, `cd ${MOUNT} && touch f && mkdir d && touch target && ln -s target link`)
    }, 120_000)

    it("chown stores the owner the guest reads back", async () => {
      expect((await sh(sandbox, `chown 1234:5678 ${MOUNT}/f`)).exitCode).toBe(0)
      expect(await statOnVolume(sandbox, "%u:%g", `${MOUNT}/f`)).toBe("1234:5678")
    })

    it("chmod stores the mode the guest reads back", async () => {
      expect((await sh(sandbox, `chmod 640 ${MOUNT}/f`)).exitCode).toBe(0)
      expect(await statOnVolume(sandbox, "%a", `${MOUNT}/f`)).toBe("640")
    })

    it("setuid and setgid bits are kept", async () => {
      await sh(sandbox, `chmod 4755 ${MOUNT}/f && chmod 2770 ${MOUNT}/d`)
      expect(await statOnVolume(sandbox, "%a", `${MOUNT}/f`)).toBe("4755")
      expect(await statOnVolume(sandbox, "%a", `${MOUNT}/d`)).toBe("2770")
    })

    it("chown -h leaves the symlink's target untouched", async () => {
      await sh(sandbox, `chown -h 3000:3001 ${MOUNT}/link`)
      expect(await statOnVolume(sandbox, "%u:%g", `${MOUNT}/target`)).toBe("0:0")
    })

    // ENG-6287: the volume root is 0750 in the guest on mk3.1 (0755 on mk3.0).
    it.skip("a non-root user can create files under the volume", async () => {
      await sh(sandbox, `mkdir -p ${MOUNT}/home && chown 1000:1000 ${MOUNT}/home`)
      const res = await sh(sandbox, `su nobody -s /bin/sh -c "touch ${MOUNT}/home/x" || setpriv --reuid=1000 --regid=1000 --clear-groups touch ${MOUNT}/home/x`)
      expect(res.exitCode).toBe(0)
    })

    // ENG-6288: virtio-fs refuses mknod on mk3.1, so FIFOs and sockets fail (they work on mk3.0).
    it.skip("FIFOs and unix sockets can be created on the volume", async () => {
      expect((await sh(sandbox, `mkfifo ${MOUNT}/fifo`)).exitCode).toBe(0)
      expect((await sh(sandbox, `python3 -c "import socket; socket.socket(socket.AF_UNIX).bind('${MOUNT}/s.sock')"`)).exitCode).toBe(0)
    })
  })

  describe("read-only volume", () => {
    let sandbox: SandboxInstance

    beforeAll(async () => {
      const volume = await newVolume("ro", 512)
      const writer = await newSandbox(volume)
      await sh(writer, `echo before > ${MOUNT}/probe && mkdir ${MOUNT}/probedir && sync`)
      await deleteSandbox(writer)
      sandbox = await newSandbox(volume, { readOnly: true })
    }, 300_000)

    it("is mounted read-only in the guest", async () => {
      const opts = (await sh(sandbox, `awk '$2 == "${MOUNT}" {print $4}' /proc/mounts`)).logs
      expect(opts.split(",")[0]).toBe("ro")
    })

    it("serves files written before it was attached", async () => {
      expect((await sh(sandbox, `cat ${MOUNT}/probe`)).logs).toBe("before")
    })

    it("refuses every mutating call with a read-only filesystem error", async () => {
      const calls = [
        "touch new", "mkdir newdir", "rmdir probedir", "rm probe", "mv probe moved",
        "ln probe hard", "ln -s probe soft", "chmod 600 probe", "chown 1:1 probe",
        "truncate -s 0 probe", "sh -c \"echo x >> probe\"",
      ]
      const res = await sh(sandbox, `cd ${MOUNT}; for c in ${calls.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(" ")}; do if out=$(eval "$c" 2>&1); then echo "$c: allowed"; else case "$out" in *"Read-only file system"*) echo "$c: EROFS";; *) echo "$c: $out";; esac; fi; done`)
      expect(res.logs.split("\n")).toEqual(calls.map(c => `${c}: EROFS`))
    })
  })

  describe("resize", () => {
    it("refuses to shrink a volume and keeps its size", async () => {
      const volume = await newVolume("shrink", 1024)
      await expect(VolumeInstance.update(volume, { size: 512 })).rejects.toThrow()
      expect((await VolumeInstance.get(volume)).size).toBe(1024)
    })

    it.runIf(isSlowTestEnabled("RUN_SLOW_VOLUME_TESTS"))("grows while mounted, without a remount", { timeout: 300_000 }, async () => {
      const volume = await newVolume("grow", 512)
      const sandbox = await newSandbox(volume)
      const sizeMiB = async () => Number((await sh(sandbox, `df -Pm ${MOUNT} | awk 'NR==2 {print $2}'`)).logs)
      expect(await sizeMiB()).toBeLessThanOrEqual(512)

      await VolumeInstance.update(volume, { size: 1024 })
      const deadline = Date.now() + 240_000
      let size = await sizeMiB()
      while (size <= 512 && Date.now() < deadline) {
        await sleep(5000)
        size = await sizeMiB()
      }
      expect(size).toBeGreaterThan(512)
      expect((await sh(sandbox, `dd if=/dev/zero of=${MOUNT}/fill bs=1M count=700 conv=fsync 2>&1`, 120)).exitCode).toBe(0)
    })
  })

  describe("filesystem API on a volume", () => {
    let sandbox: SandboxInstance

    beforeAll(async () => {
      sandbox = await newSandbox(await newVolume("fsapi", 1024))
    }, 120_000)

    it("writes and reads a file", async () => {
      await sandbox.fs.write(`${MOUNT}/a.txt`, "hello volume")
      expect(await sandbox.fs.read(`${MOUNT}/a.txt`)).toBe("hello volume")
    })

    it("round-trips 1 MiB of text unchanged", async () => {
      const content = randomBytes(512 * 1024).toString("hex")
      await sandbox.fs.write(`${MOUNT}/big.txt`, content)
      expect(createHash("sha256").update(await sandbox.fs.read(`${MOUNT}/big.txt`)).digest("hex"))
        .toBe(createHash("sha256").update(content).digest("hex"))
    })

    it("uploads a file larger than the multipart threshold", async () => {
      const content = randomBytes(6 * 1024 * 1024)
      await sandbox.fs.writeBinary(`${MOUNT}/multi.bin`, content)
      const onVolume = (await sh(sandbox, `sha256sum ${MOUNT}/multi.bin | cut -d" " -f1`)).logs
      expect(onVolume).toBe(createHash("sha256").update(content).digest("hex"))
    })

    it("lists, finds and deletes files", async () => {
      await sandbox.fs.mkdir(`${MOUNT}/tree/sub`)
      await sandbox.fs.write(`${MOUNT}/tree/one.go`, "package main")
      await sandbox.fs.write(`${MOUNT}/tree/sub/two.go`, "package sub")
      await sandbox.fs.write(`${MOUNT}/tree/notes.txt`, "notes")

      const listing = await sandbox.fs.ls(`${MOUNT}/tree`)
      expect(listing.files.map(f => f.name).sort()).toEqual(["notes.txt", "one.go"])
      expect(listing.subdirectories.map(d => d.name)).toEqual(["sub"])

      const found = await sandbox.fs.find(`${MOUNT}/tree`, { type: "file", patterns: ["*.go"] })
      expect(found.matches.map(m => m.path.split("/").pop()).sort()).toEqual(["one.go", "two.go"])

      await sandbox.fs.rm(`${MOUNT}/tree`, true)
      await expect(sandbox.fs.ls(`${MOUNT}/tree`)).rejects.toThrow()
    })

    it("searches file contents", async () => {
      await sandbox.fs.mkdir(`${MOUNT}/grep`)
      await sandbox.fs.write(`${MOUNT}/grep/a.txt`, "the needle is here")
      await sandbox.fs.write(`${MOUNT}/grep/b.txt`, "nothing to see")
      const res = await sandbox.fs.grep("needle", `${MOUNT}/grep`)
      expect(res.matches.map(m => m.path.split("/").pop())).toEqual(["a.txt"])
    })

    it("reports a change in a watched directory", async () => {
      await sandbox.fs.mkdir(`${MOUNT}/watched`)
      const seen: string[] = []
      const handle = sandbox.fs.watch(`${MOUNT}/watched`, (event) => { seen.push(event.name) })
      await sleep(1000)
      await sandbox.fs.write(`${MOUNT}/watched/new.txt`, "x")
      for (let i = 0; i < 20 && !seen.includes("new.txt"); i++) await sleep(250)
      handle.close()
      expect(seen).toContain("new.txt")
    })

    it("fails to read a missing file with a not-found error", async () => {
      await expect(sandbox.fs.read(`${MOUNT}/does-not-exist`)).rejects.toThrow(/not found|no such file|404/i)
    })
  })
})

describe.runIf(isSlowTestEnabled("RUN_VOLUME_TESTS") && isSlowTestEnabled("RUN_SLOW_VOLUME_TESTS"))("volume state across a standby", () => {
  const FILES = 20_000
  const HELD = 20_000
  let sandbox: SandboxInstance
  let parked: boolean
  let before: Record<string, number | boolean>
  let after: Record<string, number | boolean>

  async function holderCheck(): Promise<Record<string, number | boolean>> {
    const nonce = randomBytes(6).toString("hex")
    await sh(sandbox, `echo ${nonce} > /tmp/holder.req`)
    for (let i = 0; i < 120; i++) {
      const res = await sh(sandbox, `cat /tmp/holder.${nonce}.json 2>/dev/null`)
      if (res.exitCode === 0 && res.logs) return JSON.parse(res.logs) as Record<string, number | boolean>
      await sleep(1000)
    }
    throw new Error("volume-holder.py did not answer within 2 minutes")
  }

  beforeAll(async () => {
    sandbox = await newSandbox(await newVolume("standby", 2048))
    await sh(sandbox, `python3 -c "
import os
for i in range(${FILES}):
    d = os.path.join('${MOUNT}/tree', 'd%03d' % (i // 1000))
    os.makedirs(d, exist_ok=True)
    rel = os.path.join('d%03d' % (i // 1000), 'f%06d' % i)
    open(os.path.join('${MOUNT}/tree', rel), 'w').write(rel)
"`, 300)
    await sandbox.fs.write("/tmp/volume-holder.py", readFileSync(join(fixtures, "volume-holder.py"), "utf8"))
    await sandbox.process.exec({ name: "holder", command: `python3 /tmp/volume-holder.py ${MOUNT}/tree ${HELD} ${MOUNT}/scratch` })
    for (let i = 0; i < 120 && (await sh(sandbox, "test -e /tmp/holder.ready")).exitCode !== 0; i++) await sleep(1000)
    if ((await sh(sandbox, "test -e /tmp/holder.ready")).exitCode !== 0) {
      throw new Error(`volume-holder.py never got ready:\n${await sandbox.process.logs("holder")}`)
    }
    before = await holderCheck()
    parked = await parkAndWake(sandbox)
    after = await holderCheck()
  }, 900_000)

  it("the sandbox reached standby and woke up", () => {
    expect(parked).toBe(true)
  })

  it("files held open across standby still read back", () => {
    expect(before.held).toBe(HELD)
    expect(after).toMatchObject({ held: HELD, held_bad: 0 })
  })

  it("deleted files still held open read back after standby", () => {
    expect(after).toMatchObject({ small_ok: true, large_ok: true, linked_ok: true, linked_other_name_ok: true })
  })

  it("every fsynced record survives standby", () => {
    expect(after.records_bad).toBe(0)
    expect(after.records as number).toBeGreaterThanOrEqual(before.records as number)
  })

  it("the volume lists the same files after standby", async () => {
    expect((await sh(sandbox, `find ${MOUNT}/tree -type f | wc -l`, 120)).logs).toBe(String(FILES))
  })
})

// Public packages at exact top-level versions, ~50k installed files. No lockfile:
// the test needs a package manager's file workload, not a reproducible tree.
const PNPM_PROJECT = {
  name: "volume-behaviour-pnpm",
  private: true,
  dependencies: {
    "@aws-sdk/client-s3": "3.700.0", "@emotion/react": "11.14.0", "@emotion/styled": "11.14.0",
    "@mui/material": "6.1.10", "aws-cdk-lib": "2.172.0", axios: "1.7.9", constructs: "10.4.2",
    "date-fns": "4.1.0", googleapis: "144.0.0", lodash: "4.17.21", next: "15.0.4", react: "19.0.0",
    "react-dom": "19.0.0", rxjs: "7.8.1", zod: "3.24.1",
  },
  devDependencies: {
    "@babel/core": "7.26.0", "@babel/preset-env": "7.26.0", "@types/node": "22.10.2",
    "@types/react": "19.0.1", "@types/react-dom": "19.0.2", autoprefixer: "10.4.20", eslint: "9.17.0",
    "eslint-config-next": "15.0.4", jest: "29.7.0", postcss: "8.4.49", tailwindcss: "3.4.16",
    typescript: "5.7.2", webpack: "5.97.1",
  },
}

describe.runIf(isSlowTestEnabled("RUN_VOLUME_TESTS") && isSlowTestEnabled("RUN_SLOW_VOLUME_PNPM"))("pnpm install on a volume", () => {
  const APP = `${MOUNT}/app`
  const install = `cd ${APP} && /tmp/pnpm install --ignore-scripts --reporter=append-only --store-dir ${MOUNT}/.pnpm-store`
  const listing = `cd ${APP} && find node_modules | sort | md5sum`
  let sandbox: SandboxInstance
  let installed: { exitCode: number, logs: string }
  let listingBefore: string

  beforeAll(async () => {
    sandbox = await newSandbox(await newVolume("pnpm", 6144), { memory: 4096 })
    const arch = (await sh(sandbox, "uname -m")).logs === "aarch64" ? "arm64" : "x64"
    await sh(sandbox, `python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/pnpm/pnpm/releases/download/v9.15.9/pnpm-linuxstatic-${arch}', '/tmp/pnpm')" && chmod +x /tmp/pnpm`, 300)
    await sandbox.fs.mkdir(APP)
    await sandbox.fs.write(`${APP}/package.json`, JSON.stringify(PNPM_PROJECT, null, 2))
    installed = await sh(sandbox, install, 1800)
    listingBefore = (await sh(sandbox, listing, 600)).logs
  }, 2_400_000)

  it("installs a ~50k-file dependency tree", async () => {
    expect(installed.exitCode).toBe(0)
    const files = Number((await sh(sandbox, `find ${APP}/node_modules -type f | wc -l`, 300)).logs)
    expect(files).toBeGreaterThan(45_000)
  })

  it("keeps node_modules identical across a standby", { timeout: 900_000 }, async () => {
    expect(await parkAndWake(sandbox)).toBe(true)
    expect((await sh(sandbox, listing, 600)).logs).toBe(listingBefore)
    expect((await sh(sandbox, `${install} --frozen-lockfile --offline`, 600)).exitCode).toBe(0)
  })
})
