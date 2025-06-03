import { SandboxInstance } from "@blaxel/core";
import * as readline from 'readline';

async function confirmDeletion(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Are you sure you want to delete ALL sandboxes? This action cannot be undone. (y/N): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  try {
    // Test with controlplane
    const sandboxes = await SandboxInstance.list()

    if (sandboxes.length === 0) {
      console.log("No sandboxes found to delete.");
      return;
    }

    console.log(`Found ${sandboxes.length} sandbox(es) to delete:`);
    for (const sandbox of sandboxes) {
      if (sandbox.metadata?.name) {
        console.log(`- ${sandbox.metadata.name}`);
      }
    }

    const confirmed = await confirmDeletion();

    if (!confirmed) {
      console.log("Deletion cancelled.");
      return;
    }

    console.log("Proceeding with deletion...");

    for (const sandbox of sandboxes) {
      if (sandbox.metadata?.name) {
        console.log("Deleting sandbox", sandbox.metadata.name)
        await SandboxInstance.delete(sandbox.metadata.name)
      }
    }

    console.log("All sandboxes deleted successfully.");
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
