import { createOrGetSandbox } from "../utils";

const sandboxName = "next-js-2"

async function main() {
  try {
    // Test with controlplane
    const sandbox = await createOrGetSandbox({ sandboxName })
    // Verify the files were copied by listing the directory in the sandbox
    console.log('Sandbox directory contents:');
    console.log(await sandbox.fs.ls('/blaxel'));
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
