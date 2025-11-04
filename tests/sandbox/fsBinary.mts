import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox, info, sep } from "../utils";
import { createHash } from "crypto";

const sandboxName = "sandbox-test-fsbinary";

// Helper function to create a repeating pattern for large files
function createRepeatingPattern(totalSize: number): Buffer {
  const chunkSize = 1024 * 1024; // 1MB chunks
  const pattern = Buffer.alloc(chunkSize);
  for (let i = 0; i < chunkSize; i++) {
    pattern[i] = i % 256;
  }

  const chunks: Buffer[] = [];
  let remaining = totalSize;
  while (remaining > 0) {
    const toWrite = Math.min(remaining, chunkSize);
    chunks.push(pattern.subarray(0, toWrite));
    remaining -= toWrite;
  }
  return Buffer.concat(chunks);
}

// Helper function to calculate hash of buffer
function calculateHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Helper function to calculate hash of blob
async function calculateBlobHash(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return calculateHash(buffer);
}

// Test 1: Binary File Upload
async function testBinaryFileUpload(sandbox: SandboxInstance) {
  console.log(sep);
  info("Test 1: Binary File Upload");

  const timestamp = Date.now();
  const testFilePath = `/tmp/binary-file-${timestamp}.bin`;

  // Create binary test data with various byte values including null bytes
  const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xFF, 0xFE, 0xFD, 0x8A, 0x8B, 0x8C]);

  info(`Uploading binary file to ${testFilePath}...`);
  const uploadResp = await sandbox.fs.writeBinary(testFilePath, binaryData);
  console.log(`Upload response:`, uploadResp);

  info("Verifying file exists and reading it back...");
  const downloadedBlob = await sandbox.fs.readBinary(testFilePath);

  // Convert blob back to buffer for comparison
  const downloadedBuffer = Buffer.from(await downloadedBlob.arrayBuffer());

  console.log(`Original size: ${binaryData.length} bytes`);
  console.log(`Downloaded size: ${downloadedBuffer.length} bytes`);
  console.log(`Original data: ${binaryData.toString('hex')}`);
  console.log(`Downloaded data: ${downloadedBuffer.toString('hex')}`);

  // Verify data integrity
  if (binaryData.length !== downloadedBuffer.length) {
    throw new Error(`Size mismatch! Expected ${binaryData.length}, got ${downloadedBuffer.length}`);
  }

  if (!binaryData.equals(downloadedBuffer)) {
    throw new Error("Binary data mismatch! Downloaded content doesn't match uploaded content");
  }

  info("✅ Binary data verified successfully!");

  // Clean up
  info("Cleaning up test file...");
  await sandbox.fs.rm(testFilePath);
  info("✅ Test 1 passed: Binary File Upload");
}

// Test 2: Streaming Large File (5MB)
async function testStreamingLargeFile(sandbox: SandboxInstance) {
  console.log(sep);
  info("Test 2: Streaming Large File (5MB)");

  const timestamp = Date.now();
  const sourceFile = `/tmp/streaming-test-source-${timestamp}.bin`;
  const targetFile = `/tmp/streaming-test-target-${timestamp}.bin`;

  const fileSize = 5 * 1024 * 1024; // 5MB

  try {
    info(`Creating 5MB test file for streaming test...`);
    const testData = createRepeatingPattern(fileSize);
    const uploadHash = calculateHash(testData);
    console.log(`Upload hash: ${uploadHash}`);

    // Upload the file
    info(`Uploading 5MB file to ${sourceFile}...`);
    const startUpload = Date.now();
    await sandbox.fs.writeBinary(sourceFile, testData);
    const uploadDuration = Date.now() - startUpload;
    const uploadMBps = (fileSize / (1024 * 1024)) / (uploadDuration / 1000);
    info(`Upload completed in ${uploadDuration}ms (${uploadMBps.toFixed(2)} MB/s)`);

    // Download the file
    info(`Downloading 5MB file from ${sourceFile}...`);
    const startDownload = Date.now();
    const downloadedBlob = await sandbox.fs.readBinary(sourceFile);
    const downloadDuration = Date.now() - startDownload;
    const downloadMBps = (fileSize / (1024 * 1024)) / (downloadDuration / 1000);
    info(`Download completed in ${downloadDuration}ms (${downloadMBps.toFixed(2)} MB/s)`);

    // Verify download hash
    const downloadHash = await calculateBlobHash(downloadedBlob);
    console.log(`Download hash: ${downloadHash}`);

    if (downloadedBlob.size !== fileSize) {
      throw new Error(`Size mismatch! Expected ${fileSize}, got ${downloadedBlob.size}`);
    }

    if (uploadHash !== downloadHash) {
      throw new Error(`Hash mismatch! Upload: ${uploadHash}, Download: ${downloadHash}`);
    }

    info("✅ File size and hash verified successfully!");

    // Test simultaneous read/write: stream from source to target
    info("Test 3: Simultaneous read/write by streaming copy...");
    const startCopy = Date.now();

    // Download source file
    const sourceBlob = await sandbox.fs.readBinary(sourceFile);
    const sourceBuffer = Buffer.from(await sourceBlob.arrayBuffer());

    // Upload to target while processing
    await sandbox.fs.writeBinary(targetFile, sourceBuffer);

    const copyDuration = Date.now() - startCopy;
    const copyMBps = (fileSize / (1024 * 1024)) / (copyDuration / 1000);
    info(`Streaming copy completed in ${copyDuration}ms (${copyMBps.toFixed(2)} MB/s)`);

    const copyHash = calculateHash(sourceBuffer);
    console.log(`Copy hash: ${copyHash}`);

    if (uploadHash !== copyHash) {
      throw new Error(`Copy hash mismatch! Expected: ${uploadHash}, Got: ${copyHash}`);
    }

    // Verify target file by reading it back
    info("Verifying copied file integrity...");
    const verifyBlob = await sandbox.fs.readBinary(targetFile);
    const verifyHash = await calculateBlobHash(verifyBlob);
    console.log(`Verify hash: ${verifyHash}`);

    if (verifyBlob.size !== fileSize) {
      throw new Error(`Verified file size mismatch! Expected ${fileSize}, got ${verifyBlob.size}`);
    }

    if (uploadHash !== verifyHash) {
      throw new Error(`Verified hash mismatch! Expected: ${uploadHash}, Got: ${verifyHash}`);
    }

    info("✅ Copied file verified successfully!");
    info("✅ Test 2 passed: Streaming Large File");

  } finally {
    // Clean up
    info("Cleaning up test files...");
    try {
      await sandbox.fs.rm(sourceFile);
      info(`Deleted source file: ${sourceFile}`);
    } catch (e) {
      console.error(`Failed to delete source file: ${e}`);
    }

    try {
      await sandbox.fs.rm(targetFile);
      info(`Deleted target file: ${targetFile}`);
    } catch (e) {
      console.error(`Failed to delete target file: ${e}`);
    }
  }
}

// Test 3: Various binary content types
async function testVariousBinaryTypes(sandbox: SandboxInstance) {
  console.log(sep);
  info("Test 3: Various Binary Content Types");

  const timestamp = Date.now();

  // Test with different binary patterns
  const testCases = [
    { name: "All zeros", data: Buffer.alloc(1024, 0x00) },
    { name: "All ones", data: Buffer.alloc(1024, 0xFF) },
    { name: "Sequential", data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
    { name: "Random pattern", data: Buffer.from(Array.from({ length: 1024 }, () => Math.floor(Math.random() * 256))) },
  ];

  for (const testCase of testCases) {
    info(`Testing: ${testCase.name} (${testCase.data.length} bytes)`);
    const filePath = `/tmp/binary-test-${testCase.name.replace(/\s+/g, '-')}-${timestamp}.bin`;

    const originalHash = calculateHash(testCase.data);

    // Upload
    await sandbox.fs.writeBinary(filePath, testCase.data);

    // Download
    const downloadedBlob = await sandbox.fs.readBinary(filePath);
    const downloadedBuffer = Buffer.from(await downloadedBlob.arrayBuffer());
    const downloadedHash = calculateHash(downloadedBuffer);

    // Verify
    if (originalHash !== downloadedHash) {
      throw new Error(`${testCase.name}: Hash mismatch! Original: ${originalHash}, Downloaded: ${downloadedHash}`);
    }

    if (!testCase.data.equals(downloadedBuffer)) {
      throw new Error(`${testCase.name}: Binary data mismatch!`);
    }

    // Clean up
    await sandbox.fs.rm(filePath);
    info(`✅ ${testCase.name} verified`);
  }

  info("✅ Test 3 passed: Various Binary Content Types");
}

// Test 4: Binary file from local filesystem
async function testBinaryFromLocalFile(sandbox: SandboxInstance) {
  console.log(sep);
  info("Test 4: Upload Binary File from Local Filesystem");

  const timestamp = Date.now();
  const localFilePath = `/tmp/local-test-${timestamp}.bin`;
  const remoteFilePath = `/tmp/remote-test-${timestamp}.bin`;

  // Create a local binary file
  const fs = await import('fs/promises');
  const testData = Buffer.from(Array.from({ length: 10240 }, (_, i) => i % 256));
  await fs.writeFile(localFilePath, testData);

  try {
    info(`Uploading local file: ${localFilePath} -> ${remoteFilePath}`);

    // Upload using string path (filesystem path)
    await sandbox.fs.writeBinary(remoteFilePath, localFilePath);

    // Download and verify
    const downloadedBlob = await sandbox.fs.readBinary(remoteFilePath);
    const downloadedBuffer = Buffer.from(await downloadedBlob.arrayBuffer());

    const originalHash = calculateHash(testData);
    const downloadedHash = calculateHash(downloadedBuffer);

    if (originalHash !== downloadedHash) {
      throw new Error(`Hash mismatch! Original: ${originalHash}, Downloaded: ${downloadedHash}`);
    }

    info("✅ Local file uploaded and verified successfully!");

    // Clean up remote
    await sandbox.fs.rm(remoteFilePath);

  } finally {
    // Clean up local
    try {
      await fs.unlink(localFilePath);
    } catch (e) {
      console.error(`Failed to delete local file: ${e}`);
    }
  }

  info("✅ Test 4 passed: Binary File from Local Filesystem");
}

// Main test runner
async function runTests() {
  try {
    const sandbox = await createOrGetSandbox({
      sandboxName,
      image: "blaxel/base-image:latest",
      memory: 8192 // 8GB for handling 250MB files
    });

    console.log(sep);
    info("Starting Binary Filesystem Tests");
    console.log(sep);

    // Ensure tmp directory exists
    try {
      await sandbox.fs.mkdir("/tmp");
    } catch (e) {
      // Directory might already exist
    }

    // Run all tests
    await testBinaryFileUpload(sandbox);
    await testVariousBinaryTypes(sandbox);
    await testBinaryFromLocalFile(sandbox);
    await testStreamingLargeFile(sandbox); // Run this last as it's the most intensive

    console.log(sep);
    info("✅ All binary filesystem tests passed!");
    console.log(sep);

  } catch (e) {
    console.error(sep);
    console.error("❌ Test failed with error:");
    console.error(e);
    console.error(sep);
    throw e;
  } finally {
    info("Cleaning up sandbox...");
    await SandboxInstance.delete(sandboxName);
    info("✅ Cleanup complete");
  }
}

// Run tests
runTests();
