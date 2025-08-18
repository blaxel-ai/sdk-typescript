import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    console.log("Test 1: Create default sandbox...");
    let sandbox = await SandboxInstance.create();
    console.log(
      "Metadata:\n  labels: ",
      sandbox.metadata?.labels,
      "\n  displayName: ",
      sandbox.metadata?.displayName,
      "\n  name: ",
      sandbox.metadata?.name,
      "\n  createdAt: ",
      sandbox.metadata?.createdAt,
      "\n  updatedAt: ",
      sandbox.metadata?.updatedAt,
      "\n  createdBy: ",
      sandbox.metadata?.createdBy,
      "\n  updatedBy: ",
      sandbox.metadata?.updatedBy,
    )

    console.log("Test 2: Update metadata...");
    sandbox = await SandboxInstance.updateMetadata(sandbox.metadata?.name!, {
      labels: { test: "test" },
      displayName: "test"
    })
    console.log(
      "Metadata:\n  labels: ",
      sandbox.metadata?.labels,
      "\n  displayName: ",
      sandbox.metadata?.displayName,
      "\n  name: ",
      sandbox.metadata?.name,
      "\n  createdAt: ",
      sandbox.metadata?.createdAt,
      "\n  updatedAt: ",
      sandbox.metadata?.updatedAt,
      "\n  createdBy: ",
      sandbox.metadata?.createdBy,
      "\n  updatedBy: ",
      sandbox.metadata?.updatedBy,
    )

    await sandbox.fs.ls("/")
  } catch (e) {
    console.error("❌ There was an error => ", e);
    import('util').then(util => {
      console.error(util.inspect(e, { depth: null }));
    });
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("❌ There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });