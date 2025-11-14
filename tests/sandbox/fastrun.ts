import { SandboxInstance } from "@blaxel/core";

async function main() {
  const sandboxName = `fastrun-test-${Date.now()}`;

  console.log("🚀 Starting fastrun test");
  console.log(`📦 Sandbox: ${sandboxName}`);
  console.log(`🖼️  Image: blaxel/base-image\n`);

  try {
    // Create sandbox and time it
    console.log("⏱️  Creating sandbox...");
    const createStart = Date.now();
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/base-image",
    });
    console.log("Sandbox URL:", sandbox.metadata?.url);
    const createTime = Date.now() - createStart;
    console.log(`✅ Sandbox created in ${createTime}ms\n`);

    // Run ls process and time it
    console.log("⏱️  Running ls process...");
    const execStart = Date.now();
    const result = await sandbox.process.exec({ command: "ls" });
    const execTime = Date.now() - execStart;
    console.log(`✅ Process executed in ${execTime}ms\n`);

    // Print results summary
    console.log("========================================");
    console.log("           RESULTS SUMMARY");
    console.log("========================================");
    console.log(`Create time: ${createTime}ms`);
    console.log(`Exec time:   ${execTime}ms`);
    console.log(`Total time:  ${createTime + execTime}ms`);
    console.log("========================================\n");

    // Delete sandbox (no timing needed)
    console.log("🧹 Cleaning up...");
    await SandboxInstance.delete(sandboxName);
    console.log("✅ Sandbox deleted\n");

    console.log("✅ Test completed successfully!");
  } catch (error) {
    console.error("\n❌ Test failed!");
    console.error("========================================");
    console.error("           ERROR DETAILS");
    console.error("========================================");

    if (error instanceof Error) {
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      if (error.stack) {
        console.error("Stack trace:");
        console.error(error.stack);
      }
    } else if (typeof error === 'object' && error !== null) {
      console.error("Error object:");
      console.error(JSON.stringify(error, null, 2));
    } else {
      console.error("Error:", String(error));
    }

    console.error("========================================\n");

    // Attempt cleanup on error
    try {
      console.log("🧹 Attempting cleanup...");
      await SandboxInstance.delete(sandboxName);
      console.log("✅ Cleaned up sandbox after error");
    } catch (cleanupError) {
      console.error("⚠️  Failed to cleanup sandbox:");
      if (cleanupError instanceof Error) {
        console.error(cleanupError.message);
      } else {
        console.error(String(cleanupError));
      }
    }

    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

