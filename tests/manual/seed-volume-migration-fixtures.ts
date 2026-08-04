/**
 * Create ten diverse volumes for migration testing.
 *
 * The volumes are sized from 1 GiB through 10 GiB. Each is mounted on a
 * throwaway sandbox, seeded, checksummed, and then detached by deleting the
 * sandbox. The volumes and their data are preserved.
 *
 * Use cases:
 *   1. Empty volume
 *   2. Nested text tree
 *   3. Git repository clone
 *   4. Node project with npm dependencies
 *   5. Mixed binary files
 *   6. Many small files
 *   7. Large file
 *   8. Sparse file
 *   9. Links and Unix permissions
 *  10. Hidden, Unicode, spaced, and dashed filenames
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/seed-volume-migration-fixtures.ts
 *
 * Optional:
 *   REGION=us-was-1 PREFIX=mig IMAGE=blaxel/base-image:latest
 */

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set before importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, settings, VolumeInstance } from "@blaxel/core"

const REGION = process.env.REGION || "us-was-1"
const PREFIX = process.env.PREFIX || "mig"
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const MOUNT_PATH = "/volume"
const EXEC_TIMEOUT_SECONDS = 600
const MOUNT_TIMEOUT_SECONDS = 120
const RUN_ID = Date.now().toString(36)

type Fixture = {
  id: string
  sizeGb: number
  description: string
  command?: string
}

const fixtures: Fixture[] = [
  {
    id: "empty",
    sizeGb: 1,
    description: "completely empty filesystem",
  },
  {
    id: "text-tree",
    sizeGb: 2,
    description: "nested directories and text files",
    command:
      `mkdir -p ${MOUNT_PATH}/docs/guides ${MOUNT_PATH}/config ${MOUNT_PATH}/logs/archive && ` +
      `printf 'migration fixture\\n' > ${MOUNT_PATH}/README.md && ` +
      `printf 'getting started\\n' > ${MOUNT_PATH}/docs/guides/start.txt && ` +
      `printf '{"enabled":true,"version":1}\\n' > ${MOUNT_PATH}/config/app.json && ` +
      `for i in $(seq 1 100); do printf 'log line %s\\n' "$i" >> ${MOUNT_PATH}/logs/archive/app.log; done`,
  },
  {
    id: "git-clone",
    sizeGb: 3,
    description: "shallow Git repository with .git metadata",
    command:
      `(command -v git >/dev/null || ` +
      `(command -v apk >/dev/null && apk add --no-cache git) || ` +
      `(apt-get update && apt-get install -y git)) && ` +
      `git clone --depth 1 https://github.com/expressjs/express.git ${MOUNT_PATH}/express`,
  },
  {
    id: "npm-install",
    sizeGb: 4,
    description: "Node project containing package-lock.json and node_modules",
    command:
      `mkdir -p ${MOUNT_PATH}/node-project && ` +
      `printf '%s\\n' '{"name":"migration-fixture","private":true,"version":"1.0.0"}' > ${MOUNT_PATH}/node-project/package.json && ` +
      `cd ${MOUNT_PATH}/node-project && npm install --save-exact lodash@4`,
  },
  {
    id: "mixed-binary",
    sizeGb: 5,
    description: "binary files with different sizes and contents",
    command:
      `mkdir -p ${MOUNT_PATH}/binary && ` +
      `head -c 1 /dev/urandom > ${MOUNT_PATH}/binary/one-byte.bin && ` +
      `head -c 4096 /dev/urandom > ${MOUNT_PATH}/binary/4-kib.bin && ` +
      `head -c 1048576 /dev/urandom > ${MOUNT_PATH}/binary/1-mib.bin && ` +
      `dd if=/dev/zero of=${MOUNT_PATH}/binary/zero-8-mib.bin bs=1M count=8`,
  },
  {
    id: "many-small",
    sizeGb: 6,
    description: "5,000 small files spread across 50 directories",
    command:
      `mkdir -p ${MOUNT_PATH}/small-files && ` +
      `for d in $(seq 0 49); do ` +
      `mkdir -p ${MOUNT_PATH}/small-files/dir-$d; ` +
      `for f in $(seq 0 99); do printf 'directory=%s file=%s\\n' "$d" "$f" > ${MOUNT_PATH}/small-files/dir-$d/file-$f.txt; done; ` +
      `done`,
  },
  {
    id: "large-file",
    sizeGb: 7,
    description: "single 128 MiB non-sparse file",
    command:
      `mkdir -p ${MOUNT_PATH}/large && ` +
      `head -c 134217728 /dev/urandom > ${MOUNT_PATH}/large/random-128-mib.bin`,
  },
  {
    id: "sparse-file",
    sizeGb: 8,
    description: "512 MiB sparse file with data at both ends",
    command:
      `mkdir -p ${MOUNT_PATH}/sparse && ` +
      `truncate -s 536870912 ${MOUNT_PATH}/sparse/sparse-512-mib.bin && ` +
      `printf 'beginning' | dd of=${MOUNT_PATH}/sparse/sparse-512-mib.bin conv=notrunc && ` +
      `printf 'end' | dd of=${MOUNT_PATH}/sparse/sparse-512-mib.bin bs=1 seek=536870909 conv=notrunc`,
  },
  {
    id: "links-modes",
    sizeGb: 9,
    description: "symbolic links, hard links, and varied Unix permissions",
    command:
      `mkdir -p ${MOUNT_PATH}/links/bin ${MOUNT_PATH}/links/private && ` +
      `printf '#!/bin/sh\\necho migrated\\n' > ${MOUNT_PATH}/links/bin/run.sh && ` +
      `chmod 755 ${MOUNT_PATH}/links/bin/run.sh && ` +
      `printf 'secret\\n' > ${MOUNT_PATH}/links/private/secret.txt && ` +
      `chmod 600 ${MOUNT_PATH}/links/private/secret.txt && ` +
      `ln ${MOUNT_PATH}/links/private/secret.txt ${MOUNT_PATH}/links/private/secret-hardlink.txt && ` +
      `ln -s private/secret.txt ${MOUNT_PATH}/links/secret-symlink.txt`,
  },
  {
    id: "special-names",
    sizeGb: 10,
    description: "hidden, Unicode, spaced, and leading-dash filenames",
    command:
      `mkdir -p "${MOUNT_PATH}/special/directory with spaces" ${MOUNT_PATH}/special/.hidden-dir && ` +
      `printf 'spaces\\n' > "${MOUNT_PATH}/special/directory with spaces/file with spaces.txt" && ` +
      `printf 'unicode\\n' > "${MOUNT_PATH}/special/café-日本語-🚀.txt" && ` +
      `printf 'hidden\\n' > ${MOUNT_PATH}/special/.hidden && ` +
      `printf 'nested hidden\\n' > ${MOUNT_PATH}/special/.hidden-dir/value && ` +
      `printf 'dash\\n' > "${MOUNT_PATH}/special/--leading-dash.txt"`,
  },
]

function log(message: string): void {
  console.log(`[fixtures] ${message}`)
}

async function run(
  sandbox: SandboxInstance,
  command: string,
  label: string,
): Promise<string> {
  const result = await sandbox.process.exec({
    command,
    waitForCompletion: true,
    timeout: EXEC_TIMEOUT_SECONDS,
  })

  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.logs ?? ""}`)
  }

  return result.logs?.trim() ?? ""
}

async function waitForVolumeMount(sandbox: SandboxInstance, volumeName: string): Promise<void> {
  log(`waiting for ${volumeName} to be mounted at ${MOUNT_PATH}`)
  await run(
    sandbox,
    `attempt=0; ` +
      `while [ "$attempt" -lt ${MOUNT_TIMEOUT_SECONDS} ]; do ` +
      `awk -v path='${MOUNT_PATH}' '$5 == path { found = 1 } END { exit(found ? 0 : 1) }' /proc/self/mountinfo && exit 0; ` +
      `attempt=$((attempt + 1)); ` +
      `sleep 1; ` +
      `done; ` +
      `echo '${volumeName} was not mounted at ${MOUNT_PATH} within ${MOUNT_TIMEOUT_SECONDS}s' >&2; ` +
      `exit 1`,
    `wait for ${volumeName} mount`,
  )
}

async function seedFixture(fixture: Fixture): Promise<string> {
  const volumeName = `${PREFIX}-${fixture.id}-${fixture.sizeGb}gb-${RUN_ID}`
  const sandboxName = `seed-${fixture.id}-${RUN_ID}`
  const labels = {
    env: "manual-test",
    suite: "volume-migration",
    "use-case": fixture.id,
    "run-id": RUN_ID,
  }

  log(`creating ${volumeName} (${fixture.sizeGb} GiB): ${fixture.description}`)
  await VolumeInstance.create({
    name: volumeName,
    displayName: `Migration fixture: ${fixture.id}`,
    size: fixture.sizeGb * 1024,
    region: REGION,
    labels,
  })

  log(`mounting ${volumeName} on ${sandboxName}`)
  const sandbox = await SandboxInstance.create({
    name: sandboxName,
    image: IMAGE,
    memory: 2048,
    region: REGION,
    labels,
    volumes: [{ name: volumeName, mountPath: MOUNT_PATH, readOnly: false }],
  })

  try {
    await waitForVolumeMount(sandbox, volumeName)

    if (fixture.command) {
      await run(sandbox, fixture.command, `seed ${fixture.id}`)

      // The checksum manifest can be copied with the volume and compared after
      // migration. It intentionally excludes itself.
      await run(
        sandbox,
        `mkdir -p ${MOUNT_PATH}/.migration-fixture && ` +
          `printf '%s\\n' '${fixture.id}' > ${MOUNT_PATH}/.migration-fixture/use-case.txt && ` +
          `cd ${MOUNT_PATH} && ` +
          `find . -type f ! -path './.migration-fixture/manifest.sha256' -exec sha256sum '{}' + | ` +
          `LC_ALL=C sort -k2 > .migration-fixture/manifest.sha256 && sync`,
        `checksum ${fixture.id}`,
      )
    }

    const summary = await run(
      sandbox,
      `cd ${MOUNT_PATH} && ` +
        `printf 'files=' && find . -type f | wc -l && ` +
        `printf 'disk-usage=' && du -sh . | cut -f1`,
      `summarize ${fixture.id}`,
    )
    log(`seeded ${volumeName}\n${summary}`)
    return volumeName
  } finally {
    log(`deleting seeder sandbox ${sandboxName}; volume persists`)
    await SandboxInstance.delete(sandboxName).catch((error: unknown) => {
      console.error(`Failed to delete sandbox ${sandboxName}:`, error)
    })
  }
}

async function main(): Promise<void> {
  log(`workspace=${settings.workspace} region=${REGION} run=${RUN_ID}`)

  const created: string[] = []
  const failures: { fixture: string; error: unknown }[] = []

  for (const fixture of fixtures) {
    try {
      created.push(await seedFixture(fixture))
    } catch (error) {
      failures.push({ fixture: fixture.id, error })
      console.error(`[fixtures] failed ${fixture.id}:`, error)
    }
  }

  console.log("\nMigration fixture volumes:")
  for (const name of created) console.log(`  ${name}`)

  if (failures.length > 0) {
    console.error(`\n${failures.length} fixture(s) failed: ${failures.map(({ fixture }) => fixture).join(", ")}`)
    process.exitCode = 1
    return
  }

  console.log(`\nDone. Created all ${created.length} migration fixture volumes.`)
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
