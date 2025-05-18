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
    await sandbox.fs.writeFiles(files, "/blaxel/tmp")
    console.log(await sandbox.fs.ls("/blaxel/tmp"))
    await sandbox.fs.rm("/blaxel/tmp", true)
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
