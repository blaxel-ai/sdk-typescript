import { SandboxInstance } from "@blaxel/core";

const sandboxName = "sandbox-test-3"

async function main() {
  try {
    // Test with controlplane
    const sandbox = await SandboxInstance.get(sandboxName)

    const process = await sandbox.process.exec({
      name: "test",
      command: "echo 'Hello world'",
    })
    console.log(process)
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
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
