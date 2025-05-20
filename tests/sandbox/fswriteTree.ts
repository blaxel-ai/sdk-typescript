import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"

async function main() {
  try {
    const sandbox = await createOrGetSandbox(sandboxName)

    const files = [
      { path: "file1.txt", content: "Content of file 1" },
      { path: "file2.txt", content: "Content of file 2" },
      { path: "subfolder/subfile1.txt", content: "Content of subfile 1" },
      { path: "subfolder/subfile2.txt", content: "Content of subfile 2" },
    ]
    await sandbox.fs.writeTree(files, "/blaxel/tmp")
    const directory = await sandbox.fs.ls("/blaxel/tmp")
    if (!directory.files?.find(f => f.name === "file1.txt")) {
      throw new Error("file1.txt not found")
    }
    if (!directory.files?.find(f => f.name === "file2.txt")) {
      throw new Error("file2.txt not found")
    }
    if (!directory.subdirectories?.find(d => d.name === "subfolder")) {
      console.log(directory)
      throw new Error("subfolder not found")
    }
    const subDirectory = await sandbox.fs.ls("/blaxel/tmp/subfolder")
    if (!subDirectory.files?.find(f => f.name === "subfile1.txt")) {
      throw new Error("subfile1.txt not found")
    }
    if (!subDirectory.files?.find(f => f.name === "subfile2.txt")) {
      throw new Error("subfile1.txt not found")
    }
    await sandbox.fs.rm("/blaxel/tmp", true)
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    console.log("Deleting sandbox");
    await SandboxInstance.delete(sandboxName)
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
