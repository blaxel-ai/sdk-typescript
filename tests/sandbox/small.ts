import { createOrGetSandbox } from "../utils";

const sandboxName = "next-js-1"

async function main() {
  try {
    // Test with controlplane
    const start = Date.now()
    const sandbox = await createOrGetSandbox({ sandboxName })
    console.log(`Time taken for createOrGetSandbox: ${Date.now() - start}ms`);
    // Verify the files were copied by listing the directory in the sandbox
    console.log(await sandbox.process.exec({ command: 'echo "Hello, world!"', waitForCompletion: true }));
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
