import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "process-kill"

async function runProcess(sandbox: SandboxInstance) {
  await sandbox.process.exec({
    name: "dev",
    command: "npm run dev",
    workingDir: "/blaxel/app",
    waitForCompletion: false
  })
  const stream = sandbox.process.streamLogs("dev", {
    onLog: (log) => {
      console.log(log)
    }
  })
  await new Promise(resolve => setTimeout(resolve, 10000))
  await sandbox.process.kill("dev")
  stream.close()
}

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({ sandboxName })
    // Verify the files were copied by listing the directory in the sandbox
    console.log('Sandbox directory contents:');
    console.log(await sandbox.fs.ls('/blaxel'));
    await runProcess(sandbox)
    await new Promise(resolve => setTimeout(resolve, 1000))
    await runProcess(sandbox)
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
