import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    // Test with controlplane
    const sandboxes = await SandboxInstance.list()
    for (const sandbox of sandboxes) {
      if (sandbox.metadata?.name) {
        console.log("Deleting sandbox", sandbox.metadata.name)
        await SandboxInstance.delete(sandbox.metadata.name)
      }
    }
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
