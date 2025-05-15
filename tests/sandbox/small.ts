import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox(sandboxName)

    const result = await sandbox.fs.ls("/")
    console.log(result)
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
