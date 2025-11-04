import { SandboxInstance } from "@blaxel/core";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { stat } from "fs/promises";
import assert from "assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sandbox = await SandboxInstance.create()
console.log("✓ Sandbox created");

// Test text file write
await sandbox.fs.write("/tmp/test.txt", "Hello world")
console.log("✓ Text file written");

// Test binary file write
await sandbox.fs.writeBinary("/tmp/archive.zip", join(__dirname, "archive.zip"))
console.log("✓ Binary file written");

// Test ls
const listing = await sandbox.fs.ls("/tmp");
assert(listing.files.some(f => f.name === "test.txt"), "test.txt should exist in /tmp");
assert(listing.files.some(f => f.name === "archive.zip"), "archive.zip should exist in /tmp");
console.log("✓ Files listed correctly");

// Test read text file
const textContent = await sandbox.fs.read("/tmp/test.txt");
assert.strictEqual(textContent, "Hello world", "Text content should match");
console.log("✓ Text file read correctly");

// Test readBinary
const binaryBlob = await sandbox.fs.readBinary("/tmp/archive.zip");
assert(binaryBlob instanceof Blob, "readBinary should return a Blob");
console.log("✓ Binary file read correctly");
const textContentBinary = await sandbox.fs.readBinary("/tmp/test.txt");
assert(textContentBinary instanceof Blob, "readBinary should return a Blob");
console.log("✓ Binary file read correctly");

// Test download
await sandbox.fs.download("/tmp/archive.zip", join(__dirname, "archive.downloaded.zip"))
console.log("✓ Binary file downloaded");

// Compare file sizes
const originalPath = join(__dirname, "archive.zip");
const downloadedPath = join(__dirname, "archive.downloaded.zip");
const originalStats = await stat(originalPath);
const downloadedStats = await stat(downloadedPath);

console.log(`Original file size: ${originalStats.size} bytes`);
console.log(`Downloaded file size: ${downloadedStats.size} bytes`);
assert.strictEqual(downloadedStats.size, originalStats.size, "Downloaded file size should match original");
console.log("✓ File sizes match");

await SandboxInstance.delete(sandbox.metadata?.name!)
console.log("✓ Sandbox deleted");

console.log("\n✅ All tests passed!")
