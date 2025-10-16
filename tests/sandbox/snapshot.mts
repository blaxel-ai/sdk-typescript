import { SandboxInstance } from "@blaxel/core";

const sandbox = await SandboxInstance.create({ snapshotEnabled: false })
await sandbox.fs.ls("/")
console.log("waiting 20 seconds")
await new Promise(resolve => setTimeout(resolve, 20000))
await sandbox.fs.ls("/")

const sandbox2 = await SandboxInstance.create({})
await sandbox2.fs.ls("/")
console.log("waiting 20 seconds")
await new Promise(resolve => setTimeout(resolve, 20000))
console.log(await sandbox2.fs.ls("/"))
