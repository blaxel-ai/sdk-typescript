import { promises as fs } from "fs";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"

async function main() {
  try {
    const sandbox = await createOrGetSandbox(sandboxName)

    // Read archive.zip as binary
    const archiveBuffer = await fs.readFile("tests/sandbox/archive.zip")
    await sandbox.fs.writeBinary("/blaxel/archive.zip", archiveBuffer)
    const directory = await sandbox.fs.ls("/blaxel")
    if (!directory.files?.find(f => f.name === "archive.zip")) {
      throw new Error("archive.zip not found")
    }
    // Optionally, check file size matches
    const localSize = archiveBuffer.length
    const remoteSize = directory.files?.find(f => f.name === "archive.zip")?.size
    if (remoteSize !== localSize) {
      throw new Error(`archive.zip size mismatch: local=${localSize}, remote=${remoteSize}`)
    }
    // await sandbox.fs.rm("/blaxel/archive.zip")
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
