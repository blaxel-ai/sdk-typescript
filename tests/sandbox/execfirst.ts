import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

async function main() {
  const sandboxCreated: string[] = []
  try {
    let i = 0;
    while (i < 10) {
      const sandboxName = `next-js-${i}`
      const sandbox = await createOrGetSandbox({ sandboxName })
      const process =await sandbox.process.exec({
        command: "echo 'Hello, world!'",
        workingDir: "/blaxel",
        waitForCompletion: true,
      })
      console.log(process.logs)
      sandboxCreated.push(sandboxName)
      i++
    }
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    for (const sandboxName of sandboxCreated) {
      await SandboxInstance.delete(sandboxName)
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
