import { SandboxInstance, logger } from "@blaxel/core";

const sandboxName = "next-js-25"

logger.setLogger(console)

async function main() {
  try {
    const start = Date.now()
    // Test with controlplane
    // const sandbox = await createOrGetSandbox({ sandboxName })
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/dev-base:latest",
      memory: 4096,
    })
    console.log(`Sandbox create time: ${Date.now() - start}ms`)
    const startWait = Date.now()
    await sandbox.wait()
    console.log(`Sandbox wait time: ${Date.now() - startWait}ms`)
    console.log(`Sandbox create time after watch: ${Date.now() - start}ms`)

    // Verify the files were copied by listing the directory in the sandbox

    const startLs = Date.now()
    console.log(await sandbox.fs.ls('/blaxel'));
    console.log(`Ls time: ${Date.now() - startLs}ms`)
    const startLs2 = Date.now()
    console.log(await sandbox.fs.ls('/blaxel'));
    console.log(`Ls time: ${Date.now() - startLs2}ms`)
    const end = Date.now()
    console.log(`Time taken: ${end - start}ms`)
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
