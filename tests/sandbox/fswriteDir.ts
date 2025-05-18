import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"

async function main() {
  try {
    // Create temporary directory structure
    const tmpDir = fs.mkdtempSync(os.tmpdir());
    console.log(`Created temporary directory: ${tmpDir}`);

    // Create files in the main folder
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'Content of file 1');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'Content of file 2');

    // Create subfolder
    const subDir = path.join(tmpDir, 'subfolder');
    fs.mkdirSync(subDir);

    // Create files in the subfolder
    fs.writeFileSync(path.join(subDir, 'subfile1.txt'), 'Content of subfile 1');
    fs.writeFileSync(path.join(subDir, 'subfile2.txt'), 'Content of subfile 2');

    // Create another level of nesting
    const nestedDir = path.join(subDir, 'nested');
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, 'nested-file.txt'), 'Content of nested file');

    // Test with controlplane
    const sandbox = await createOrGetSandbox(sandboxName)

    // List the contents of the temporary directory
    console.log('Local temporary directory structure:');
    console.log(fs.readdirSync(tmpDir));
    console.log('Subfolder contents:');
    console.log(fs.readdirSync(subDir));

    // Use writeDir to copy the temporary directory to the sandbox
    console.log('Copying temporary directory to sandbox...');
    const result = await sandbox.fs.writeDir(tmpDir, '/blaxel/tmp');
    console.log('WriteDir result:', result);

    // Verify the files were copied by listing the directory in the sandbox
    console.log('Sandbox directory contents:');
    console.log(await sandbox.fs.ls('/blaxel/tmp'));

    // Cleanup temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Removed temporary directory: ${tmpDir}`);
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
