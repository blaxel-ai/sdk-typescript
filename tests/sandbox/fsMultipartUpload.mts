import { SandboxInstance } from "@blaxel/core";
import assert from "node:assert";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testMultipartUpload() {
  console.log("=== Starting Multipart Upload Tests ===\n");

  const sandbox = await SandboxInstance.create();
  console.log("✓ Sandbox created:", sandbox.metadata!.name);

  try {
    // Test 1: Small file (should use regular upload)
    console.log("\n[TEST 1] Uploading small file (< 1MB)...");
    const smallContent = "Hello, world! ".repeat(1000); // ~14KB
    const smallSize = new Blob([smallContent]).size;
    console.log(`  File size: ${(smallSize / 1024).toFixed(2)} KB`);

    await sandbox.fs.write("/tmp/small-file.txt", smallContent);
    console.log("✓ Small file uploaded successfully");

    const readSmall = await sandbox.fs.read("/tmp/small-file.txt");
    assert(readSmall === smallContent, "Small file content should match");
    console.log("✓ Small file content verified");

    // Test 2: Large text file (should use multipart upload)
    console.log("\n[TEST 2] Uploading large text file (> 1MB)...");
    const largeContent = "Large file content line. ".repeat(50000); // ~1.2MB
    const largeSize = new Blob([largeContent]).size;
    console.log(`  File size: ${(largeSize / 1024 / 1024).toFixed(2)} MB`);

    await sandbox.fs.write("/tmp/large-file.txt", largeContent);
    console.log("✓ Large text file uploaded with multipart");

    const readLarge = await sandbox.fs.read("/tmp/large-file.txt");
    assert(readLarge === largeContent, "Large file content should match");
    console.log("✓ Large file content verified");

    // Test 3: Large binary file (should use multipart upload)
    console.log("\n[TEST 3] Uploading large binary file (> 1MB)...");
    const binarySize = 2 * 1024 * 1024; // 2MB
    const binaryContent = new Uint8Array(binarySize);
    // Fill with pattern for verification
    for (let i = 0; i < binarySize; i++) {
      binaryContent[i] = i % 256;
    }
    console.log(`  File size: ${(binarySize / 1024 / 1024).toFixed(2)} MB`);

    await sandbox.fs.writeBinary("/tmp/large-binary.bin", binaryContent);
    console.log("✓ Large binary file uploaded with multipart");

    const readBinary = await sandbox.fs.readBinary("/tmp/large-binary.bin");
    const readBinaryArray = new Uint8Array(await readBinary.arrayBuffer());
    assert(readBinaryArray.length === binarySize, "Binary file size should match");
    assert(readBinaryArray.every((val, idx) => val === idx % 256), "Binary content should match pattern");
    console.log("✓ Large binary file content verified");

    // Test 4: Very large file (multiple parts)
    console.log("\n[TEST 4] Uploading very large file (> 5MB, multiple parts)...");
    const veryLargeContent = "X".repeat(6 * 1024 * 1024); // 6MB (will be split into 2 parts)
    const veryLargeSize = new Blob([veryLargeContent]).size;
    console.log(`  File size: ${(veryLargeSize / 1024 / 1024).toFixed(2)} MB`);

    await sandbox.fs.write("/tmp/very-large-file.txt", veryLargeContent);
    console.log("✓ Very large file uploaded with multipart (multiple parts)");

    const readVeryLarge = await sandbox.fs.read("/tmp/very-large-file.txt");
    assert(readVeryLarge.length === veryLargeContent.length, "Very large file size should match");
    console.log("✓ Very large file content verified");

    // Test 5: Upload and download real image file
    console.log("\n[TEST 5] Uploading and downloading real image file...");
    const imagePath = join(__dirname, "assets", "sample-image.png");
    const imageBuffer = await readFile(imagePath);
    const imageSize = imageBuffer.length;
    console.log(`  Original image size: ${(imageSize / 1024).toFixed(2)} KB`);

    // Upload the image
    await sandbox.fs.writeBinary("/tmp/uploaded-image.png", imageBuffer);
    console.log("✓ Image uploaded to sandbox");

    // Download the image back
    const downloadPath = join(__dirname, "assets", "downloaded-image.png");
    await sandbox.fs.download("/tmp/uploaded-image.png", downloadPath);
    console.log("✓ Image downloaded from sandbox");

    // Read the downloaded image and compare
    const downloadedBuffer = await readFile(downloadPath);
    console.log(`  Downloaded image size: ${(downloadedBuffer.length / 1024).toFixed(2)} KB`);

    // Verify sizes match
    assert(downloadedBuffer.length === imageBuffer.length, "Downloaded image size should match original");
    console.log("✓ Image sizes match");

    // Verify byte-by-byte content
    assert(Buffer.compare(imageBuffer, downloadedBuffer) === 0, "Downloaded image content should match original");
    console.log("✓ Image content verified (byte-perfect match)");

    // Test 6: List files to verify all uploads
    console.log("\n[TEST 6] Verifying all uploaded files...");
    const files = await sandbox.fs.ls("/tmp");
    const uploadedFiles = files.files.map(f => f.name);
    console.log(`  Uploaded files: ${uploadedFiles.join(", ")}`);

    assert(uploadedFiles.includes("small-file.txt"), "Should find small-file.txt");
    assert(uploadedFiles.includes("large-file.txt"), "Should find large-file.txt");
    assert(uploadedFiles.includes("large-binary.bin"), "Should find large-binary.bin");
    assert(uploadedFiles.includes("very-large-file.txt"), "Should find very-large-file.txt");
    assert(uploadedFiles.includes("uploaded-image.png"), "Should find uploaded-image.png");
    console.log("✓ All uploaded files found");

    console.log("\n✅ All multipart upload tests passed!");

  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  } finally {
    console.log("\nCleaning up...");

    // Clean up downloaded image
    try {
      const downloadPath = join(__dirname, "assets", "downloaded-image.png");
      const { unlink } = await import("fs/promises");
      await unlink(downloadPath);
      console.log("✓ Downloaded image cleaned up");
    } catch (e) {
      // File might not exist if test failed before download
    }

    await SandboxInstance.delete(sandbox.metadata!.name!);
    console.log("✓ Sandbox cleaned up");
  }
}

console.log("Starting multipart upload tests...\n");
testMultipartUpload()
  .then(() => {
    console.log("\n✅ === All tests completed successfully ===");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ === Tests failed ===");
    console.error(error);
    process.exit(1);
  });
