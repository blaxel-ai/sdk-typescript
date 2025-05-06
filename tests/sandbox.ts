import { Directory, SandboxInstance } from "@blaxel/core";

const sandboxName = "sandbox-test-3"

async function testFilesystem(sandbox: SandboxInstance) {
  const user = process.env.USER;
  await sandbox.fs.write(`/Users/${user}/Downloads/test`, "Hello world");
  const content = await sandbox.fs.read(`/Users/${user}/Downloads/test`);
  if (content !== "Hello world") {
    throw new Error("File content is not correct");
  }
  const dir = await sandbox.fs.ls(`/Users/${user}/Downloads`);
  if (dir.files?.length && dir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!dir.files?.find((f) => f.path === `/Users/${user}/Downloads/test`)) {
    throw new Error("File not found in directory");
  }

  await sandbox.fs.mkdir(`/Users/${user}/Downloads/test2`);
  const afterMkdir = await sandbox.fs.ls(`/Users/${user}/Downloads/test2`) as Directory;
  if (afterMkdir.files?.length && afterMkdir.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  await sandbox.fs.cp(`/Users/${user}/Downloads/test`, `/Users/${user}/Downloads/test2/test`);
  const afterCpLs = await sandbox.fs.ls(`/Users/${user}/Downloads/test2`) as Directory;
  if (afterCpLs.files?.length && afterCpLs.files?.length < 1) {
    throw new Error("Directory is empty");
  }
  if (!afterCpLs.files?.find((f) => f.path === `/Users/${user}/Downloads/test2/test`)) {
    throw new Error("File not found in directory");
  }
  await sandbox.fs.rm(`/Users/${user}/Downloads/test`);
  try {
    await sandbox.fs.rm(`/Users/${user}/Downloads/test2`);
  } catch (e) {
    console.log("That is expected => ", e.error);
  }
  await sandbox.fs.rm(`/Users/${user}/Downloads/test2`, true);
}

async function testProcess(uvm: SandboxInstance) {
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

async function testPreviewPublic(sandbox: SandboxInstance) {
  try {
    await sandbox.previews.create({
      metadata: {
        name: "preview-test-public"
      },
      spec: {
        port: 443,
        public: true
      }
    })
    const previews = await sandbox.previews.list()
    if (previews.length < 1) {
      throw new Error("No previews found");
    }
    const preview = await sandbox.previews.get("preview-test-public")
    if (preview.name !== "preview-test-public") {
      throw new Error("Preview name is not correct");
    }
    const url = preview.spec?.url
    if (!url) {
      throw new Error("Preview URL is not correct");
    }
    const response = await fetch(`${url}/health`)
    if (response.status !== 200) {
      throw new Error("Preview is not working");
    }
    console.log("Preview is healthy :)")
  } catch (e) {
    console.log("ERROR IN PREVIEWS NOT EXPECTED => ", e);
  } finally {
    await sandbox.previews.delete("preview-test-public")
  }
  }

async function testPreviewToken(sandbox: SandboxInstance) {
  try {
    const preview = await sandbox.previews.create({
      metadata: {
        name: "preview-test-private"
      },
      spec: {
        port: 443,
        public: false
      }
    })
    const url = preview.spec?.url
    if (!url) {
      throw new Error("Preview URL is not correct");
    }
    const token = await preview.tokens.create(new Date(Date.now() + 1000 * 60 * 10)) // 10 minutes expiration
    console.log("Token created => ", token.value)
    const tokens = await preview.tokens.list()
    if (tokens.length < 1) {
      throw new Error("No tokens found");
    }
    if (!tokens.find((t) => t.value === token.value)) {
      throw new Error("Token not found in list");
    }
    console.log("Token created => ", token.value)
    const response = await fetch(`${url}/health`)
    if (response.status !== 401) {
      throw new Error(`Preview is not protected by token, response => ${response.status}`);
    }

    const responseWithToken = await fetch(`${url}/health?bl_preview_token=${token.value}`)
    if (responseWithToken.status !== 200) {
      throw new Error(`Preview is not working with token, response => ${responseWithToken.status}`);
    }
    console.log("Preview is healthy with token :)")
    await preview.tokens.delete(token.value)
  } catch (e) {
    console.log("ERROR IN PREVIEWS NOT EXPECTED => ", e);
  } finally {
    await sandbox.previews.delete("preview-test-private")
  }
}

async function testPreviews(sandbox: SandboxInstance) {
  await testPreviewPublic(sandbox)
  await testPreviewToken(sandbox)
}

async function createSandbox() {
  console.log("Creating sandbox");
  const sandbox = await SandboxInstance.create({
    metadata: {
      name: sandboxName
    },
    spec: {
      runtime: {
        image: "blaxel/prod-base:latest",
        memory: 2048,
        ports: [
          {
            name: "sandbox-api",
            target: 8080,
            protocol: "HTTP",
          }
        ]
      }
    }
  })
  // By default, the interval is 1 second and max wait is 60 seconds
  // Wait for sandbox to be deployed, max wait of 120 seconds and interval of 1 second
  console.log("Sandbox deployed");
  await sandbox.wait({ maxWait: 120000, interval: 1000 })
  return sandbox
}

async function testSandbox() {
  let sandbox: SandboxInstance;
  // Create a sandbox, then you can play with it
  sandbox = await createSandbox()

  console.log("Getting same sandbox");
  sandbox = await SandboxInstance.get(sandboxName)
  // Fix this before uncomment
  // console.log(await sandbox.fs.ls("/"))
  return sandbox
}

async function main() {
  try {
    // Test with controlplane
    const sandbox = await testSandbox()
    // const sandbox = await SandboxInstance.get(sandboxName)

    await testFilesystem(sandbox);
    await testProcess(sandbox);
    await testPreviews(sandbox);
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
