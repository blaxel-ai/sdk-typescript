import { UVMInstance } from "../src";
import { Directory } from "../src/sandbox/client";

process.env.BL_UVM_TEST_URL = "http://localhost:8080";

async function testFilesystem(uvm: UVMInstance) {
  const user = process.env.USER;
  await uvm.fs.write(`/Users/${user}/Downloads/test`, "Hello world");
  const content = await uvm.fs.read(`/Users/${user}/Downloads/test`);
  if (content !== "Hello world") {
    throw new Error("File content is not correct");
  }
  const dir = await uvm.fs.ls(`/Users/${user}/Downloads`);
  if (dir.files?.length && dir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!dir.files?.find((f) => f.path === `/Users/${user}/Downloads/test`)) {
    throw new Error("File not found in directory");
  }

  await uvm.fs.mkdir(`/Users/${user}/Downloads/test2`);
  const afterMkdir = await uvm.fs.ls(`/Users/${user}/Downloads/test2`) as Directory;
  if (afterMkdir.files?.length && afterMkdir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  await uvm.fs.cp(`/Users/${user}/Downloads/test`, `/Users/${user}/Downloads/test2/test`);
  const afterCpLs = await uvm.fs.ls(`/Users/${user}/Downloads/test2`) as Directory;
  if (afterCpLs.files?.length && afterCpLs.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!afterCpLs.files?.find((f) => f.path === `/Users/${user}/Downloads/test2/test`)) {
    throw new Error("File not found in directory");
  }
  await uvm.fs.rm(`/Users/${user}/Downloads/test`);
  try {
    await uvm.fs.rm(`/Users/${user}/Downloads/test2`);
  } catch (e) {
    console.log("That is expected => ", e.error);
  }
  await uvm.fs.rm(`/Users/${user}/Downloads/test2`, true);
}

async function testProcess(uvm: UVMInstance) {
  const process = await uvm.process.exec({
    name: "test",
    command: "echo 'Hello world'",
  });
  if (process.status === "completed") {
    throw new Error("Process did complete without waiting");
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const completedProcess = await uvm.process.get("test");
  if (completedProcess.status !== "completed") {
    throw new Error("Process did not complete");
  }
  const logs = await uvm.process.logs("test");
  if (logs != 'Hello world\n') {
    throw new Error("Logs are not correct");
  }
  try {
    await uvm.process.kill("test");
  } catch (e) {
    console.log("That is expected => ", e.error);
  }
}

async function main() {
  const uvm = new UVMInstance({
    metadata: {
      name: "test",
    },
  });
  await testFilesystem(uvm);
  await testProcess(uvm);
}

main()
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  })
