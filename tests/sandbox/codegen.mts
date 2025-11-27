import { SandboxInstance } from "@blaxel/core";
import dotenv from "dotenv";
import assert from "node:assert";

dotenv.config();

async function relace() {
  console.log("[RELACE] Starting test...");

  const sandbox = await SandboxInstance.create({
    envs: [
      { name: "RELACE_API_KEY", value: process.env.RELACE_API_KEY! },
    ]
  })
  console.log("[RELACE] ✓ Sandbox created:", sandbox.metadata!.name);

  console.log("[RELACE] Applying first code edit...");
  await sandbox.codegen.fastapply("/tmp/test.txt", "// ... existing code ...\nconsole.log('Hello, world!');")
  console.log("[RELACE] ✓ First edit applied successfully");

  let content = await sandbox.fs.read("/tmp/test.txt");
  console.log("[RELACE] Content after first edit:", content);
  assert(content.includes("Hello, world!"), "First edit should contain 'Hello, world!'");
  console.log("[RELACE] ✓ First edit assertion passed");

  console.log("[RELACE] Applying second code edit...");
  await sandbox.codegen.fastapply("/tmp/test.txt", "// ... keep existing code\nconsole.log('The meaning of life is 42');")
  console.log("[RELACE] ✓ Second edit applied successfully");

  content = await sandbox.fs.read("/tmp/test.txt");
  console.log("[RELACE] Content after second edit:", content);
  assert(content.includes("The meaning of life is 42"), "Second edit should contain 'The meaning of life is 42'");
  assert(content.includes("Hello, world!"), "Original content should be preserved");
  console.log("[RELACE] ✓ Second edit assertions passed");

  console.log("[RELACE] Testing reranking...");
  const result = await sandbox.codegen.reranking("/tmp", "What is the meaning of life?", 0.01, 1000, ".*\\.txt$")
  console.log("[RELACE] Reranking result:", JSON.stringify(result, null, 2));
  assert(result !== null && result !== undefined, "Reranking should return a result");
  assert(result.files?.find(f => f.path?.includes("test.txt")) !== undefined, "Reranking should return the test.txt file");
  console.log("[RELACE] ✓ Reranking assertions passed");

  console.log("[RELACE] ✅ Test completed successfully");
  await SandboxInstance.delete(sandbox.metadata!.name!);
  console.log("[RELACE] ✓ Sandbox cleaned up");
}

async function morph() {
  console.log("[MORPH] Starting test...");

  const sandbox = await SandboxInstance.create({
    envs: [
      { name: "MORPH_API_KEY", value: process.env.MORPH_API_KEY! },
    ]
  })
  console.log("[MORPH] ✓ Sandbox created:", sandbox.metadata!.name);

  console.log("[MORPH] Applying first code edit...");
  await sandbox.codegen.fastapply("/tmp/test.txt", "// ... existing code ...\nconsole.log('Hello, world!');")
  console.log("[MORPH] ✓ First edit applied successfully");

  let content = await sandbox.fs.read("/tmp/test.txt");
  console.log("[MORPH] Content after first edit:", content);
  assert(content.includes("Hello, world!"), "First edit should contain 'Hello, world!'");
  console.log("[MORPH] ✓ First edit assertion passed");

  console.log("[MORPH] Applying second code edit...");
  await sandbox.codegen.fastapply("/tmp/test.txt", "// ... keep existing code\nconsole.log('The meaning of life is 42');")
  console.log("[MORPH] ✓ Second edit applied successfully");

  content = await sandbox.fs.read("/tmp/test.txt");
  console.log("[MORPH] Content after second edit:", content);
  assert(content.includes("The meaning of life is 42"), "Second edit should contain 'The meaning of life is 42'");
  assert(content.includes("Hello, world!"), "Original content should be preserved");
  console.log("[MORPH] ✓ Second edit assertions passed");

  console.log("[MORPH] Testing reranking...");
  const result = await sandbox.codegen.reranking("/tmp", "What is the meaning of life?", 0.01, 1000000, ".*\\.txt$")
  console.log("[MORPH] Reranking result:", JSON.stringify(result, null, 2));
  assert(result !== null && result !== undefined, "Reranking should return a result");
  assert(result.files?.find(f => f.path?.includes("test.txt")) !== undefined, "Reranking should return the test.txt file");
  console.log("[MORPH] ✓ Reranking assertions passed");

  console.log("[MORPH] ✅ Test completed successfully");
  await SandboxInstance.delete(sandbox.metadata!.name!);
  console.log("[MORPH] ✓ Sandbox cleaned up");
}

console.log("=== Starting Codegen Tests ===\n");

try {
  await relace();
  console.log("\n");
  await morph();
  console.log("\n✅ === All tests passed! ===");
} catch (error) {
  console.error("\n❌ === Test failed with error ===");
  console.error(error);
  process.exit(1);
}
