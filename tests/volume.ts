import { SandboxInstance, VolumeInstance } from "@blaxel/core";
import console from "console";

/**
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 * @param sandboxName The name of the sandbox to wait for deletion
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deletion completed, false if timeout
 */
async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  console.log(`⏳ Waiting for ${sandboxName} deletion to fully complete...`);
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName);
      // If we get here, sandbox still exists, wait and try again
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      console.log(`   Still exists, waiting... (${attempts}/${maxAttempts})`);
    } catch (error) {
      // If getSandbox throws an error, the sandbox no longer exists
      console.log(`✅ ${sandboxName} fully deleted`);
      return true;
    }
  }

  console.log(`⚠️ Timeout waiting for ${sandboxName} deletion to complete`);
  return false;
}

async function main() {
  try {
    console.log("🗄️  Simple Volume Persistence Test");
    console.log("=" .repeat(40));

    // Choose image based on BL_ENV
    const isDev = process.env.BL_ENV === 'dev';
    const imageBase = isDev ? 'dev-base' : 'prod-base';
    const image = `blaxel/${imageBase}:latest`;
    const fileContent = "Hello from sandbox!";

    console.log(`Using image: ${image} (BL_ENV=${process.env.BL_ENV || 'not set'})`);

    // Step 1: Create a volume
    console.log("\n1. Creating a volume...");
    const volume = await VolumeInstance.create({
      name: "test-persistence-volume",
      displayName: "Test Persistence Volume",
      size: 1024 // 1GB
    });
    console.log(`✅ Volume created: ${volume.name}`);

    // Step 2: Create a sandbox with that volume
    console.log("\n2. Creating sandbox with volume...");
    const sandbox = await SandboxInstance.create({
      name: "first-sandbox",
      image: image,
      memory: 2048,
      volumes: [
        {
          name: "test-persistence-volume",
          mountPath: "/persistent-data",
          readOnly: false
        }
      ]
    });
    console.log(`✅ Sandbox created: ${sandbox.metadata?.name}`);

    // Step 3: Put a file in that volume
    console.log("\n3. Writing file to volume...");
    await sandbox.process.exec({
      command: `echo '${fileContent}' > /persistent-data/test-file.txt`,
      waitForCompletion: true
    });
    console.log("✅ File written to volume");

    // Step 4: Retrieve the file in that volume
    console.log("\n4. Reading file from volume in first sandbox...");

    // Debug: Check mount points
    console.log("🔍 Debug: Checking mount points...");
    const mountCheck = await sandbox.process.exec({
      command: "mount | grep persistent-data",
      waitForCompletion: true
    });
    console.log(`Mount info: ${mountCheck.logs?.trim() || 'No mount found'}`);

    // Debug: Check directory structure and file existence
    console.log("🔍 Debug: Checking directory structure...");
    const dirCheck = await sandbox.process.exec({
      command: "ls -la /persistent-data/",
      waitForCompletion: true
    });
    console.log(`Directory listing: ${dirCheck.logs?.trim()}`);

    // Debug: Check if specific file exists
    console.log("🔍 Debug: Checking if test-file.txt exists...");
    const fileExists = await sandbox.process.exec({
      command: "test -f /persistent-data/test-file.txt && echo 'File exists' || echo 'File does not exist'",
      waitForCompletion: true
    });
    console.log(`File existence check: ${fileExists.logs?.trim()}`);

    // Debug: Check file ownership and permissions
    console.log("🔍 Debug: Checking file details...");
    const fileDetails = await sandbox.process.exec({
      command: "ls -la /persistent-data/test-file.txt 2>/dev/null || echo 'Cannot access file'",
      waitForCompletion: true
    });
    console.log(`File details: ${fileDetails.logs?.trim()}`);

    // Try to read the file content
    const firstRead = await sandbox.process.exec({
      command: "cat /persistent-data/test-file.txt",
      waitForCompletion: true
    });
    console.log(`✅ File content: ${firstRead.logs?.trim()}`);

    // Step 5: Delete the sandbox
    console.log("\n5. Deleting first sandbox...");
    await SandboxInstance.delete("first-sandbox");
    console.log("✅ First sandbox deleted");

    // Wait for deletion to fully complete
    const deletionCompleted = await waitForSandboxDeletion("first-sandbox");
    if (!deletionCompleted) {
      throw new Error("Timeout waiting for sandbox deletion to complete");
    }

    // Step 6: Create a new sandbox with previous volume
    console.log("\n6. Creating new sandbox with same volume...");
    const newSandbox = await SandboxInstance.create({
      name: "second-sandbox",
      image: image,
      memory: 2048,
      volumes: [
        {
          name: "test-persistence-volume",
          mountPath: "/data", // Different mount path to show flexibility
          readOnly: false
        }
      ]
    });
    // const newSandbox = await SandboxInstance.get("second-sandbox");
    console.log(`✅ New sandbox created: ${newSandbox.metadata?.name}`);

    // Step 7: Retrieve the file in that volume
    console.log("\n7. Reading file from volume in second sandbox...");

    // Debug: Check mount points in new sandbox
    console.log("🔍 Debug: Checking mount points in new sandbox...");
    const newMountCheck = await newSandbox.process.exec({
      command: "mount | grep data",
      waitForCompletion: true
    });
    console.log(`Mount info: ${newMountCheck.logs?.trim() || 'No mount found'}`);

    // Debug: Check directory structure and file existence in new sandbox
    console.log("🔍 Debug: Checking directory structure in new sandbox...");
    const newDirCheck = await newSandbox.process.exec({
      command: "ls -la /data/",
      waitForCompletion: true
    });
    console.log(`Directory listing (/data): ${newDirCheck.logs?.trim()}`);

    // Debug: Check if specific file exists in new sandbox
    console.log("🔍 Debug: Checking if test-file.txt exists in new sandbox...");
    const newFileExists = await newSandbox.process.exec({
      command: "test -f /data/test-file.txt && echo 'File exists' || echo 'File does not exist'",
      waitForCompletion: true
    });
    console.log(`File existence check: ${newFileExists.logs?.trim()}`);

    // Debug: Check file ownership and permissions in new sandbox
    console.log("🔍 Debug: Checking file details in new sandbox...");
    const newFileDetails = await newSandbox.process.exec({
      command: "ls -la /data/test-file.txt 2>/dev/null || echo 'Cannot access file'",
      waitForCompletion: true
    });
    console.log(`File details: ${newFileDetails.logs?.trim()}`);

    // Debug: Check current user and groups
    console.log("🔍 Debug: Checking current user and groups...");
    const userInfo = await newSandbox.process.exec({
      command: "whoami && groups",
      waitForCompletion: true
    });
    console.log(`Current user and groups: ${userInfo.logs?.trim()}`);

    // Try to read the file content
    const secondRead = await newSandbox.process.exec({
      command: "cat /data/test-file.txt",
      onLog: (log) => {
        console.log(`🔍 Log: ${log}`);
      },
      waitForCompletion: true
    });
    console.log(`✅ File content from new sandbox: ${secondRead.logs?.trim()}`);

    // Verify persistence worked
    const persistedContent = secondRead.logs?.trim();

    if (fileContent === persistedContent) {
      console.log("\n🎉 SUCCESS: Volume data persisted across sandbox recreations!");
      console.log(`   Original: "${fileContent}"`);
      console.log(`   Persisted: "${persistedContent}"`);
    } else {
      console.log("\n❌ FAILURE: Volume data did not persist correctly");
      console.log(`   Expected: "${fileContent}"`);
      console.log(`   Got: "${persistedContent}"`);
    }

    console.log("\n✨ Test completed successfully!");

  } catch (e) {
    console.error("❌ Test failed with error:", e);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      await SandboxInstance.delete("first-sandbox");
    } catch {}
    try {
      await SandboxInstance.delete("second-sandbox");
      await waitForSandboxDeletion("second-sandbox");
    } catch (e) {
      console.log("❌ Sandbox not found", e.message);
    }

    try {
      await VolumeInstance.delete("test-persistence-volume");
    } catch (e) {
      console.log("❌ Volume not found", e.message);
    }
  }
}

main()
  .catch((err) => {
    console.error("❌ There was an error =>", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
