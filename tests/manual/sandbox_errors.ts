// Manual test: read the infrastructure failures the compute plane recorded on a
// sandbox (controlplane#5198).
//
// The compute plane matches configured patterns in the microVM logs and signals
// them to the control plane, which appends them to `sandbox.errors` (oldest
// first, bounded) and moves the sandbox to FAILED for the fatal ones. Only a
// single-sandbox read returns the array: listings never carry it.
//
// Flow:
//   1. Read one sandbox (an existing NAME, or a freshly created one).
//   2. Print its errors, separating the fatal ones from the informational ones.
//   3. Show that a listing does NOT carry the array.
//
// The dev compute plane ships two fake patterns to produce entries on demand,
// both matched in the microVM logs of the sandbox:
//   echo blaxel-fake-vmm-error   -> VM_EXITED-like, non-fatal, sandbox keeps running
//   echo blaxel-fake-vm-error    -> fatal, moves the sandbox to FAILED
// so a sandbox with no incident at all legitimately reports an empty array.
//
// Run (after `npm run build` in @blaxel/core):
//
//   npx tsx tests/manual/sandbox_errors.ts
//
// Env vars:
//   NAME      sandbox to read (default: create a throwaway one)
//   IMAGE     image for the created sandbox (default blaxel/base-image:latest)
//   REGION    region to create the sandbox in (optional)
//   CLEANUP   delete a created sandbox at the end (default "true")

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const name = process.env.NAME
const image = process.env.IMAGE ?? "blaxel/base-image:latest"
const region = process.env.REGION
const cleanup = (process.env.CLEANUP ?? "true") !== "false"

async function main() {
  let created = false
  let sandbox: SandboxInstance

  if (name) {
    sandbox = await SandboxInstance.get(name)
  } else {
    const generated = `errors-${uuidv4().slice(0, 8)}`
    console.log(`creating sandbox ${generated}`)
    sandbox = await SandboxInstance.createIfNotExists({
      name: generated,
      image,
      ...(region ? { region } : {}),
    })
    created = true
  }

  console.log(`sandbox ${sandbox.metadata?.name} status=${sandbox.status}`)

  // Always an array: empty when the sandbox never hit an infrastructure failure.
  const errors = sandbox.errors
  console.log(`${errors.length} infrastructure error(s) recorded`)
  for (const error of errors) {
    console.log(
      `  ${error.time} ${error.code} fatal=${error.fatal ?? false}` +
        ` instance=${error.instance ?? "-"}${error.message ? ` ${error.message}` : ""}`
    )
  }

  const fatal = errors.filter((error) => error.fatal)
  if (fatal.length > 0) {
    // The last fatal entry is why the sandbox is FAILED, and its code is the
    // same one the gateway answers with (WORKLOAD_FAILED responses).
    console.log(`sandbox failed on ${fatal[fatal.length - 1].code}`)
  }

  // Listings drop the array, so never look for a failure reason there.
  const page = await SandboxInstance.list({ limit: 1 })
  const listed = page.data[0]
  if (listed) {
    console.log(
      `listed ${listed.metadata?.name} carries errors: ${listed.errors.length > 0}`
    )
  }

  if (created && cleanup) {
    await SandboxInstance.delete(sandbox.metadata?.name ?? "")
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
