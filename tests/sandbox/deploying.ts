import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-deploy"

async function main() {
  try {
    // Test with controlplane
    const start = Date.now()
    const sandbox = await createOrGetSandbox(sandboxName)
    // Verify the files were copied by listing the directory in the sandbox
    await sandbox.fs.ls('/')
    const end = Date.now()
    console.log(`Time taken: ${end - start}ms`)
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    await SandboxInstance.delete(sandboxName)
    while (true) {
      try {
        await SandboxInstance.get(sandboxName)
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch {
        break
      }
    }
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
