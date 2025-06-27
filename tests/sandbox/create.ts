import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    let sandbox = await SandboxInstance.create()
    await sandbox.wait()
    console.log(await sandbox.fs.ls('/blaxel'))
    await SandboxInstance.delete(sandbox.metadata?.name!)

    sandbox = await SandboxInstance.create(
      { spec: { runtime: { image: "blaxel/prod-base:latest" } } }
    )
    await sandbox.wait()
    console.log(await sandbox.fs.ls('/blaxel'))
    await SandboxInstance.delete(sandbox.metadata?.name!)

    sandbox = await SandboxInstance.create({ name: "sandbox-with-name" })
    await sandbox.wait()
    console.log(await sandbox.fs.ls('/blaxel/'))
    await SandboxInstance.delete(sandbox.metadata?.name!)

    sandbox = await SandboxInstance.createIfNotExists({ name: "sandbox-cine-name" })
    await sandbox.wait()
    console.log(await sandbox.fs.ls('/blaxel/'))
    await SandboxInstance.delete(sandbox.metadata?.name!)

    sandbox = await SandboxInstance.createIfNotExists({ metadata: { name: "sandbox-cine-metadata" } })
    await sandbox.wait()
    console.log(await sandbox.fs.ls('/blaxel/'))
    await SandboxInstance.delete(sandbox.metadata?.name!)
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

main()
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  })
